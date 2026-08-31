/* Pointer-driven QR reveal. Opening is only completed by sliding the handle. */
(function () {
  var overlay = document.getElementById('mysteryBoxOverlay');
  var slider = document.getElementById('mysterySlider');
  var boxOpenSound = document.getElementById('boxOpenSound');
  var rewardSound = document.getElementById('rewardSound');
  var stage = document.querySelector('.stage');
  if (!overlay || !slider) return;

  var thumb = slider.querySelector('.mystery-slider__thumb');
  var progress = 0;
  var dragging = false;
  var opened = false;
  var pointerId = null;
  var threshold = .88;

  if (boxOpenSound) boxOpenSound.volume = .34;
  if (rewardSound) rewardSound.volume = .26;

  function prepareSound(audio) {
    if (!audio) return;
    try { audio.load(); } catch {}
  }

  function playSound(audio) {
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
      var playback = audio.play();
      if (playback && typeof playback.catch === 'function') playback.catch(function () {});
    } catch {}
  }

  document.body.classList.add('mystery-box-active');
  if (stage) stage.setAttribute('inert', '');

  function setProgress(value) {
    progress = Math.max(0, Math.min(1, value));
    var rect = slider.getBoundingClientRect();
    var thumbSize = thumb ? thumb.offsetWidth : 52;
    var maxX = Math.max(0, rect.width - thumbSize - 8);
    slider.style.setProperty('--mystery-fill', (progress * 100) + '%');
    slider.style.setProperty('--mystery-thumb-x', (4 + maxX * progress) + 'px');
    slider.setAttribute('aria-valuenow', Math.round(progress * 100));
    slider.setAttribute('aria-valuetext', Math.round(progress * 100) + ' percent. Slide right to open.');
  }

  function progressFromClientX(clientX) {
    var rect = slider.getBoundingClientRect();
    var thumbSize = thumb ? thumb.offsetWidth : 52;
    var maxX = Math.max(1, rect.width - thumbSize - 8);
    return (clientX - rect.left - 4 - thumbSize / 2) / maxX;
  }

  function finishOpen() {
    if (opened) return;
    opened = true;
    dragging = false;
    slider.classList.remove('is-dragging');
    slider.classList.add('is-complete');
    setProgress(1);
    playSound(boxOpenSound);
    overlay.classList.add('is-opening');

    window.setTimeout(function () {
      playSound(rewardSound);
      overlay.classList.add('is-revealed');
      overlay.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('mystery-box-active');
      if (stage) stage.removeAttribute('inert');
    }, 820);
  }

  function releasePointer() {
    if (!dragging) return;
    dragging = false;
    slider.classList.remove('is-dragging');
    if (progress >= threshold) {
      finishOpen();
    } else {
      setProgress(0);
    }
    pointerId = null;
  }

  slider.addEventListener('pointerdown', function (event) {
    if (opened) return;
    prepareSound(boxOpenSound);
    prepareSound(rewardSound);
    dragging = true;
    pointerId = event.pointerId;
    slider.classList.add('is-dragging');
    slider.setPointerCapture(event.pointerId);
    setProgress(progressFromClientX(event.clientX));
    event.preventDefault();
  });

  slider.addEventListener('pointermove', function (event) {
    if (!dragging || event.pointerId !== pointerId || opened) return;
    setProgress(progressFromClientX(event.clientX));
    event.preventDefault();
  });

  slider.addEventListener('pointerup', releasePointer);
  slider.addEventListener('pointercancel', releasePointer);
  slider.addEventListener('lostpointercapture', function () {
    if (dragging) releasePointer();
  });

  slider.addEventListener('keydown', function (event) {
    if (opened) return;
    prepareSound(boxOpenSound);
    prepareSound(rewardSound);
    var step = event.shiftKey ? .2 : .1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      setProgress(progress + step);event.preventDefault();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      setProgress(progress - step);event.preventDefault();
    } else if (event.key === 'Home') {
      setProgress(0);event.preventDefault();
    } else if (event.key === 'End') {
      setProgress(1);event.preventDefault();
    }
    if (progress >= threshold) finishOpen();
  });

  window.addEventListener('resize', function () { setProgress(progress); });
  setProgress(0);
})();
