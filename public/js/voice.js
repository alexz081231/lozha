// Голосовой чат: WebRTC «каждый с каждым» (mesh). Сигналы идут через общий канал событий.
import { h, ls, isIOS } from './util.js';
import { icon } from './icons.js';
import { rt, store } from './api.js';
import { toast } from './ui.js';

const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

export class Voice {
  constructor({ onChange = () => {}, onSpeaking = () => {} } = {}) {
    this.onChange = onChange;
    this.onSpeaking = onSpeaking;
    this.joined = false;
    this.muted = false;
    this.listenOnly = false;
    this.stream = null;
    this.ctx = null;
    this.peers = new Map(); // cid → { pc, audio, uid }
    this.speaking = new Set(); // cid говорящих (включая себя)
    this.level = 0;
    this.mySpeaking = false;
    this.volumes = ls.get('voicevol', {});
    this.uidOf = () => null;
  }

  volumeOf(uid) { return this.volumes[uid] ?? 1; }
  setVolume(uid, v) {
    this.volumes[uid] = v;
    ls.set('voicevol', this.volumes);
    for (const p of this.peers.values()) if (p.uid === uid && p.audio) this.applyVolume(p);
  }
  applyVolume(p) {
    const v = this.volumeOf(p.uid);
    try { p.audio.volume = Math.min(1, v); } catch {}
    p.audio.muted = v === 0; // на iPhone громкость элемента не меняется — там ползунок в нуле выключает звук
  }

  async mic() {
    if (ls.get('fakemic')) { // для автопроверки: «микрофон» из генератора тона
      const osc = this.ctx.createOscillator(), g = this.ctx.createGain(), dst = this.ctx.createMediaStreamDestination();
      osc.frequency.value = 330;
      g.gain.value = 0.3;
      osc.connect(g).connect(dst);
      osc.start();
      this.fake = setInterval(() => { g.gain.value = g.gain.value ? 0 : 0.3; }, 1200);
      return dst.stream;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('insecure'), { name: 'Insecure' });
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  }

  async join() {
    if (this.joined || this.joining) return;
    this.joining = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !this.ctx) this.ctx = new AC();
      try { await this.ctx?.resume(); } catch {}
      try {
        this.stream = await this.mic();
        this.listenOnly = false;
      } catch (e) {
        this.stream = null;
        this.listenOnly = true;
        toast(e.name === 'Insecure' ? 'Микрофон работает только по HTTPS (запусти npm run https и открой https-адрес). Пока ты слышишь остальных, но тебя не слышно.'
          : e.name === 'NotAllowedError' ? 'Доступ к микрофону запрещён — ты слышишь остальных, но тебя не слышно. Разреши микрофон в настройках сайта.'
            : 'Микрофон не найден — ты слышишь остальных, но тебя не слышно.', { timeout: 7000 });
      }
      this.joined = true;
      this.muted = false;
      if (this.stream && this.ctx) this.watchLevel();
      rt.send({ t: 'voice:join', muted: this.listenOnly });
    } finally { this.joining = false; }
    this.onChange();
  }

  leave(silent = false) {
    if (!this.joined) return;
    this.joined = false;
    if (!silent) rt.send({ t: 'voice:leave' });
    for (const cid of [...this.peers.keys()]) this.drop(cid);
    clearInterval(this.levelTimer);
    clearInterval(this.fake);
    for (const t of this.stream?.getTracks() || []) t.stop();
    this.stream = null;
    this.level = 0;
    this.mySpeaking = false;
    this.speaking.clear();
    this.onSpeaking();
    this.onChange();
  }

  toggleMute() {
    if (!this.joined || this.listenOnly) return;
    this.muted = !this.muted;
    for (const t of this.stream.getAudioTracks()) t.enabled = !this.muted;
    if (this.muted) this.mySpeaking = false;
    this.sendState();
    this.onChange();
  }

  sendState() {
    rt.send({ t: 'voice:state', muted: this.muted || this.listenOnly, speaking: this.mySpeaking });
  }

  // Индикатор «говорит»: уровень сигнала с микрофона с небольшим удержанием.
  watchLevel() {
    const src = this.ctx.createMediaStreamSource(this.stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let hold = 0;
    this.levelTimer = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / buf.length);
      this.level = this.muted ? 0 : Math.min(1, rms * 7);
      const now = performance.now();
      if (!this.muted && rms > 0.03) hold = now + 380;
      const sp = now < hold;
      if (sp !== this.mySpeaking) { this.mySpeaking = sp; this.sendState(); }
      this.onLevel?.(this.level);
    }, 70);
  }

  handle(m) {
    if (m.t === 'voice:state') {
      if (m.speaking) this.speaking.add(m.cid); else this.speaking.delete(m.cid);
      return this.onSpeaking();
    }
    if (m.t === 'voice:left') {
      this.drop(m.cid);
      this.speaking.delete(m.cid);
      this.onSpeaking();
      return this.onChange();
    }
    if (!this.joined) return;
    if (m.t === 'voice:peers') { for (const cid of m.peers) this.connect(cid, true); this.onChange(); } // мы новенькие — звоним всем, кто уже в голосе
    else if (m.t === 'voice:signal') this.signal(m.from, m.data).catch((e) => console.warn('voice', e));
  }

  // Кто-то говорит (кроме меня) — фильм стоит приглушить.
  othersSpeaking() {
    if (!this.joined) return false;
    for (const cid of this.speaking) if (cid !== rt.cid) return true;
    return false;
  }

  connect(cid, initiator) {
    let p = this.peers.get(cid);
    if (p) return p;
    const pc = new RTCPeerConnection({ iceServers: ICE });
    p = { cid, pc, audio: null, uid: this.uidOf(cid), pending: [], remoteSet: false, initiator };
    this.peers.set(cid, p);
    if (this.stream) for (const t of this.stream.getAudioTracks()) pc.addTrack(t, this.stream);
    else if (initiator) pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.onicecandidate = (e) => { if (e.candidate) rt.send({ t: 'voice:signal', to: cid, data: { ice: e.candidate } }); };
    pc.ontrack = (e) => {
      if (!p.audio) {
        p.audio = new Audio();
        p.audio.autoplay = true;
        p.audio.setAttribute('playsinline', '');
      }
      p.audio.srcObject = e.streams[0] || new MediaStream([e.track]);
      p.uid = this.uidOf(cid) ?? p.uid;
      this.applyVolume(p);
      p.audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && this.peers.get(cid) === p) {
        this.drop(cid);
        if (initiator) setTimeout(() => { if (this.joined && !this.peers.has(cid)) this.connect(cid, true); }, 1200);
      }
      this.onChange();
    };
    if (initiator) {
      pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => rt.send({ t: 'voice:signal', to: cid, data: { sdp: pc.localDescription } })).catch((e) => console.warn('voice offer', e));
    }
    return p;
  }

  async signal(from, data) {
    let p = this.peers.get(from);
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        if (p) this.drop(from); // собеседник переподключается
        p = this.connect(from, false);
        await p.pc.setRemoteDescription(data.sdp);
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        rt.send({ t: 'voice:signal', to: from, data: { sdp: p.pc.localDescription } });
      } else if (p) {
        await p.pc.setRemoteDescription(data.sdp);
      }
      if (p) {
        p.remoteSet = true;
        for (const c of p.pending.splice(0)) p.pc.addIceCandidate(c).catch(() => {});
      }
    } else if (data.ice && p) {
      if (p.remoteSet) p.pc.addIceCandidate(data.ice).catch(() => {});
      else p.pending.push(data.ice);
    }
  }

  drop(cid) {
    const p = this.peers.get(cid);
    if (!p) return;
    this.peers.delete(cid);
    try { p.pc.onconnectionstatechange = null; p.pc.close(); } catch {}
    if (p.audio) { try { p.audio.pause(); p.audio.srcObject = null; } catch {} }
  }

  connected() {
    let n = 0;
    for (const p of this.peers.values()) if (p.pc.connectionState === 'connected') n++;
    return n;
  }
}

// Кнопки голоса: подключиться, микрофон вкл/выкл, уровень, выйти.
export function voiceBar(voice) {
  const el = h('div.voice');
  const lvl = h('i');
  const draw = () => {
    if (!voice.joined) {
      el.replaceChildren(h('button.btn', { type: 'button', title: 'Подключиться к голосовому чату', onclick: () => voice.join() }, icon('phones', 'ic-s'), h('span', 'Голос')));
      return;
    }
    const on = !voice.muted && !voice.listenOnly;
    const n = voice.peers.size;
    el.replaceChildren(
      h(`button.btn${on ? '.live' : ''}`, {
        type: 'button', disabled: voice.listenOnly, title: voice.listenOnly ? 'Микрофон недоступен — ты только слушаешь' : (on ? 'Выключить микрофон' : 'Включить микрофон'),
        onclick: () => voice.toggleMute(),
      }, icon(on ? 'mic' : 'micOff', 'ic-s'), h('span', voice.listenOnly ? 'Слушаю' : on ? 'Микрофон' : 'Выключен'), on ? h('span.lvl', lvl) : null),
      h('span.small.muted.num', n ? `в голосе: ${n + 1}` : 'пока один'),
      h('button.btn.btn-ghost.btn-icon', { type: 'button', title: 'Выйти из голосового чата', onclick: () => voice.leave() }, icon('x', 'ic-s')),
    );
  };
  voice.onLevel = (v) => { lvl.style.height = `${Math.round(v * 100)}%`; };
  draw();
  el.draw = draw;
  return el;
}

export const mySelf = () => store.me;
