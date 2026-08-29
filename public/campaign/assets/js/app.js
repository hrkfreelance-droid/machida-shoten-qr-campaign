(function () {
  'use strict';

  var TOP_URL = 'https://machida-shoten-cambodia.netlify.app/';

  var body = document.body;
  var step1 = document.getElementById('step1');
  var step2 = document.getElementById('step2');
  var nextBtn = document.getElementById('nextBtn');
  var closeBtn1 = document.getElementById('closeBtn1');
  var closeBtn2 = document.getElementById('closeBtn2');

  function showStep(step, opts) {
    opts = opts || {};
    if (step === 2) {
      step1.hidden = true;
      step1.setAttribute('aria-hidden', 'true');
      step2.hidden = false;
      step2.setAttribute('aria-hidden', 'false');
      body.setAttribute('data-step', '2');
      window.scrollTo(0, 0);
      pauseSparks();
    } else {
      step2.hidden = true;
      step2.setAttribute('aria-hidden', 'true');
      step1.hidden = false;
      step1.setAttribute('aria-hidden', 'false');
      body.setAttribute('data-step', '1');
      resumeSparks();
    }
    if (!opts.silent) {
      var qs = window.location.search || '';
      var url = window.location.pathname + qs + (step === 2 ? '#iekei' : '');
      history.pushState({ step: step }, '', url);
    }
  }

  function goToStep2() {
    showStep(2);
  }

  function goHome() {
    window.location.href = TOP_URL;
  }

  nextBtn.addEventListener('click', goToStep2);
  closeBtn1.addEventListener('click', goHome);
  closeBtn2.addEventListener('click', goHome);

  window.addEventListener('popstate', function (e) {
    var step = (e.state && e.state.step) || (window.location.hash === '#iekei' ? 2 : 1);
    showStep(step, { silent: true });
  });

  // Establish an initial history entry so Back from step 2 lands on step 1
  // rather than leaving the campaign entirely.
  history.replaceState({ step: 1 }, '', window.location.pathname + (window.location.search || ''));

  if (window.location.hash === '#iekei') {
    showStep(2, { silent: true });
  }

  // ===== Step 1 visual effects: entrance timeline, ember particles =====
  // Ambient effects only — copy, layout and navigation above are untouched.
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var entranceRan = false;
  var pauseSparks = function () {};
  var resumeSparks = function () {};

  function runEntrance() {
    if (entranceRan || reduceMotion || !window.gsap) return;
    var logo = document.querySelector('.anim-logo');
    var ramen = document.querySelector('.anim-ramen');
    var free = document.querySelector('.anim-free');
    var angkor = document.querySelector('.anim-angkor');
    var next = document.querySelector('.anim-next');
    if (!logo || !ramen || !free || !angkor || !next) return;

    entranceRan = true;

    var tl = gsap.timeline({
      defaults: { ease: 'power2.out' },
      onComplete: function () {
        // Hand elements back to plain CSS once the one-time entrance is done.
        gsap.set([logo, ramen, free, angkor, next], { clearProps: 'all' });
        ramen.classList.add('is-floating');
      }
    });

    tl.fromTo(logo, { opacity: 0, y: -10, scale: .97 }, { opacity: 1, y: 0, scale: 1, duration: .4 }, 0)
      .fromTo(ramen, { opacity: 0, y: 18, scale: .92 }, { opacity: 1, y: 0, scale: 1, duration: .55, ease: 'back.out(1.5)' }, .15)
      .fromTo(free, { opacity: 0, scale: .92 }, { opacity: 1, scale: 1, duration: .32 }, .35)
      .fromTo(angkor, { opacity: 0, scale: .94 }, { opacity: 1, scale: 1, duration: .32 }, .5)
      .fromTo(next, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .32 }, .7);
  }

  function initSparks() {
    if (reduceMotion) return;
    var canvas = document.getElementById('sparkCanvas');
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    // v2: a bit more present than v1 (14 -> 22), still sparse — not confetti/snow.
    var COUNT = 22;
    var w = 0, h = 0, particles = [], raf = null, running = false;

    function resize() {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, w * dpr);
      canvas.height = Math.max(1, h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function makeParticle(spread) {
      var colors = ['255,150,90', '255,186,90', '255,104,70', '255,210,140'];
      return {
        x: Math.random() * w,
        y: spread ? Math.random() * h : h + Math.random() * 40,
        r: 1 + Math.random() * 2,
        speed: .14 + Math.random() * .3,
        drift: (Math.random() - .5) * .45,
        alpha: .25 + Math.random() * .4,
        color: colors[(Math.random() * colors.length) | 0]
      };
    }

    function seed() {
      particles = [];
      for (var i = 0; i < COUNT; i++) particles.push(makeParticle(true));
    }

    function tick() {
      if (!running) return;
      ctx.clearRect(0, 0, w, h);
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.y -= p.speed;
        p.x += p.drift;
        if (p.y < -10) { particles[i] = makeParticle(false); continue; }
        ctx.beginPath();
        ctx.fillStyle = 'rgba(' + p.color + ',' + p.alpha + ')';
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    }

    function start() {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(tick);
    }
    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
    }

    resize();
    seed();
    start();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else if (body.getAttribute('data-step') === '1') start();
    });

    pauseSparks = stop;
    resumeSparks = start;
  }

  runEntrance();
  initSparks();

  // ===== Page 2 (Iekei explainer, 01-05): lightweight scroll reveal =====
  // CSS already forces full visibility under prefers-reduced-motion, so this
  // is purely an enhancement — never required for content to show.
  (function initP2Reveal() {
    var targets = document.querySelectorAll('.p2-sec, .p2-closing');
    if (!targets.length) return;
    if (!('IntersectionObserver' in window) || reduceMotion) {
      targets.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' });
    targets.forEach(function (el) { io.observe(el); });
  })();
})();
