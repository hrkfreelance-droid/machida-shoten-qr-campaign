/* Soft cross-page wipe. Falls back to a normal link if anything is off. */
(function () {
  var wipe = document.querySelector('.wipe');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!wipe || reduce) return;

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-nav]');
    if (!a) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
    e.preventDefault();
    wipe.classList.add('is-on');
    setTimeout(function () { window.location.href = a.href; }, 260);
  });

  // Coming back via bfcache: make sure the wipe is cleared.
  window.addEventListener('pageshow', function () { wipe.classList.remove('is-on'); });
})();
