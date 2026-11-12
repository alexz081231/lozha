// Переходы между страницами (History API). Сам рендер подключает app.js.
export const nav = {
  render: () => {},
  go(path, { replace = false } = {}) {
    if (!replace && path === location.pathname + location.search) return;
    history[replace ? 'replaceState' : 'pushState'](null, '', path);
    this.render();
  },
  back(fallback = '/') {
    if (history.length > 1 && document.referrer !== '' || window.__navDepth > 0) history.back();
    else this.go(fallback, { replace: true });
  },
};
window.__navDepth = 0;
