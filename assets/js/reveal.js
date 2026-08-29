/* Page 2 scroll reveals.
   IntersectionObserver drives the entrance; a rAF-throttled scroll pass is the
   safety net, because a fast flick can coalesce IO updates and skip a section
   — which would leave it stuck at opacity 0 for the rest of the visit. */
(function () {
  var els = Array.prototype.slice.call(document.querySelectorAll('[data-rv]'));
  if (!els.length) return;

  function showAll() { els.forEach(function (el) { el.classList.add('is-in'); }); els = []; }

  if (!('IntersectionObserver' in window) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    showAll();
    return;
  }

  function show(el) {
    el.classList.add('is-in');
    var i = els.indexOf(el);
    if (i > -1) els.splice(i, 1);
    io.unobserve(el);
    if (!els.length) window.removeEventListener('scroll', onScroll);
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) { if (en.isIntersecting) show(en.target); });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });

  els.forEach(function (el) { io.observe(el); });

  var ticking = false;
  function sweep() {
    ticking = false;
    var limit = window.innerHeight * 0.92;
    els.slice().forEach(function (el) {
      if (el.getBoundingClientRect().top < limit) show(el);
    });
  }
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(sweep);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  onScroll();
})();
