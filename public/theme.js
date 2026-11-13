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

  // Everything in this app is shown in Malaysia time (Asia/Kuala_Lumpur),
  // regardless of what timezone the viewing device itself is set to —
  // important once orders are viewed from different tills/devices.
  var TZ = 'Asia/Kuala_Lumpur';
  function toDate(d) { return d instanceof Date ? d : new Date(d); }
  var fmtHM = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  var fmtHMS = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  var fmtYMD = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

  window.cafeTime = {
    hm: function (d) { return fmtHM.format(toDate(d)); },
    hms: function (d) { return fmtHMS.format(toDate(d)); },
    ymd: function (d) { return fmtYMD.format(toDate(d)); },
    now: function () { return new Date(); }
  };

  // Keeps the screen from auto-locking while a till/brew-board page is left
  // open. Safari on iPadOS supports the Screen Wake Lock API from 16.4+; on
  // older versions this just quietly does nothing (no error, no crash).
  var wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      // e.g. page not visible yet, or battery saver — safe to ignore, we retry on visibilitychange
    }
  }
  window.cafeKeepAwake = function () {
    requestWakeLock();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') requestWakeLock();
    });
  };
})();
