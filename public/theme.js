(function () {
  var KEY = 'cafe-theme'; // 'system' | 'light' | 'dark'

  function apply(t) {
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }

  function icon(t) {
    return t === 'dark' ? '🌙' : t === 'light' ? '☀️' : '🌓';
  }

  var current = localStorage.getItem(KEY) || 'system';
  apply(current);

  window.cafeTheme = {
    get: function () { return localStorage.getItem(KEY) || 'system'; },
    cycle: function () {
      var cur = this.get();
      var next = cur === 'system' ? 'light' : (cur === 'light' ? 'dark' : 'system');
      localStorage.setItem(KEY, next);
      apply(next);
      return next;
    },
    icon: icon
  };

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('themeBtn');
    if (!btn) return;
    btn.textContent = icon(window.cafeTheme.get());
    btn.addEventListener('click', function () {
      btn.textContent = icon(window.cafeTheme.cycle());
    });
  });
})();
