// Тема ставится до первой отрисовки, чтобы страница не мигала.
(function () {
  var pref = 'auto';
  try { pref = localStorage.getItem('lozha.theme') || 'auto'; } catch (e) {}
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function apply() {
    var light = pref === 'light' || (pref === 'auto' && mq && mq.matches);
    document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#f3f3f3' : '#060606');
  }
  apply();
  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', apply); else if (mq.addListener) mq.addListener(apply);
  }
  window.__theme = {
    get: function () { return pref; },
    set: function (v) { pref = v; try { localStorage.setItem('lozha.theme', v); } catch (e) {} apply(); },
  };
})();
