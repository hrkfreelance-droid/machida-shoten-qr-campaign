/* Anonymous coupon status and staff-confirmed slider redemption. Server is authoritative. */
(function () {
  var body = document.body;
  var offer = document.getElementById('couponOffer');
  var reward = document.getElementById('couponReward');
  var unavailable = document.getElementById('couponUnavailable');
  var unavailableTitle = document.getElementById('couponUnavailableTitle');
  var unavailableCopy = document.getElementById('couponUnavailableCopy');
  var redeemed = document.getElementById('couponRedeemed');
  var meta = document.getElementById('couponMeta');
  var couponId = document.getElementById('couponId');
  var markUsed = document.getElementById('markUsedButton');
  var modal = document.getElementById('redeemModal');
  var groupCheck = document.getElementById('groupCheck');
  var promotionCheck = document.getElementById('promotionCheck');
  var redeemSlider = document.getElementById('redeemSlider');
  var redeemThumb = redeemSlider ? redeemSlider.querySelector('.redeem-slider__thumb') : null;
  var redeemStatus = document.getElementById('redeemStatus');
  var cancelRedeem = document.getElementById('cancelRedeem');
  var cancelRedeemTop = document.getElementById('cancelRedeemTop');
  var redeemedAt = document.getElementById('redeemedAt');
  var availableAgainAt = document.getElementById('availableAgainAt');
  var retryStatus = document.getElementById('retryStatus');
  if (!body || !offer || !markUsed || !modal || !groupCheck || !promotionCheck || !redeemSlider || !redeemStatus) return;

  var apiUrl = body.getAttribute('data-coupon-api-url') || '';
  var deviceStorageKey = 'machida_coupon_device_id';
  var deviceId = null;
  var currentCouponId = null;
  var currentState = 'CHECKING';
  var redeemProgress = 0;
  var redeemDragging = false;
  var redeemPointerId = null;
  var redeemPointerStartX = 0;
  var redeemPointerMoved = false;
  var redeemInFlight = false;
  var redeemThreshold = .92;
  var redeemAudioContext = null;

  function isUuid(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function makeUuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
      var random = Math.random() * 16 | 0;
      var value = char === 'x' ? random : (random & 3 | 8);
      return value.toString(16);
    });
  }

  function getDeviceId() {
    try {
      var existing = window.localStorage.getItem(deviceStorageKey);
      if (isUuid(existing)) return existing;
      var next = makeUuid();
      window.localStorage.setItem(deviceStorageKey, next);
      return next;
    } catch {
      return null;
    }
  }

  function formatDate(value, includeTime) {
    if (!value) return '—';
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Phnom_Penh', day: '2-digit', month: 'short', year: 'numeric',
        ...(includeTime ? { hour: '2-digit', minute: '2-digit', hour12: true } : {})
      }).format(new Date(value));
    } catch {
      return '—';
    }
  }

  function announceState(state, detail) {
    currentState = state;
    body.dataset.couponState = state;
    document.dispatchEvent(new CustomEvent('machida:coupon-state', { detail: { status: state, ...detail } }));
  }

  function showActive(detail) {
    reward.hidden = false;
    unavailable.hidden = true;
    redeemed.hidden = true;
    meta.hidden = false;
    currentCouponId = detail.coupon_id;
    couponId.textContent = detail.coupon_id || '—';
    markUsed.disabled = !currentCouponId;
    retryStatus.hidden = true;
    offer.dataset.couponState = 'ACTIVE';
    announceState('ACTIVE', detail);
    updateRedeemAvailability();
  }

  function showLocked(detail) {
    closeModal(true);
    reward.hidden = true;
    unavailable.hidden = false;
    redeemed.hidden = true;
    meta.hidden = true;
    markUsed.disabled = true;
    retryStatus.hidden = true;
    currentCouponId = null;
    unavailableTitle.textContent = 'Reward Already Used';
    unavailableCopy.textContent = 'Next reward: ' + formatDate(detail.available_again_at, false) + '.';
    offer.dataset.couponState = 'LOCKED';
    announceState('LOCKED', detail);
  }

  function showUnavailable(message) {
    closeModal(true);
    reward.hidden = true;
    unavailable.hidden = false;
    redeemed.hidden = true;
    meta.hidden = true;
    markUsed.disabled = true;
    currentCouponId = null;
    retryStatus.hidden = false;
    unavailableTitle.textContent = 'Reward Temporarily Unavailable';
    unavailableCopy.textContent = message || 'We couldn’t verify your reward right now. Please try again later.';
    offer.dataset.couponState = 'UNAVAILABLE';
    announceState('UNAVAILABLE', {});
  }

  function showRedeemed(detail) {
    closeModal(true);
    reward.hidden = true;
    unavailable.hidden = true;
    redeemed.hidden = false;
    meta.hidden = true;
    markUsed.disabled = true;
    retryStatus.hidden = true;
    currentCouponId = null;
    offer.dataset.couponState = 'REDEEMED';
    redeemedAt.textContent = formatDate(detail.redeemed_at, true);
    availableAgainAt.textContent = formatDate(detail.available_again_at, false);
    announceState('REDEEMED', detail);
  }

  async function request(payload) {
    var headers = { 'Content-Type': 'application/json' };
    var response = await fetch(apiUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      cache: 'no-store',
      credentials: 'omit'
    });
    var data = {};
    try { data = await response.json(); } catch {}
    return { ok: response.ok, status: response.status, data: data };
  }

  function setRedeemProgress(value) {
    redeemProgress = Math.max(0, Math.min(1, value));
    var rect = redeemSlider.getBoundingClientRect();
    var thumbSize = redeemThumb ? redeemThumb.offsetWidth : 50;
    var maxX = Math.max(0, rect.width - thumbSize - 8);
    redeemSlider.style.setProperty('--redeem-fill', (redeemProgress * 100) + '%');
    redeemSlider.style.setProperty('--redeem-thumb-x', (4 + maxX * redeemProgress) + 'px');
    redeemSlider.setAttribute('aria-valuenow', Math.round(redeemProgress * 100));
    redeemSlider.setAttribute('aria-valuetext', Math.round(redeemProgress * 100) + ' percent. Slide right to mark as used.');
  }

  function progressFromClientX(clientX) {
    var rect = redeemSlider.getBoundingClientRect();
    var thumbSize = redeemThumb ? redeemThumb.offsetWidth : 50;
    var maxX = Math.max(1, rect.width - thumbSize - 8);
    return (clientX - rect.left - 4 - thumbSize / 2) / maxX;
  }

  function updateRedeemAvailability() {
    var enabled = currentState === 'ACTIVE' && !!currentCouponId &&
      groupCheck.checked && promotionCheck.checked && !redeemInFlight;
    redeemSlider.classList.toggle('is-disabled', !enabled);
    redeemSlider.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    if (!enabled && redeemProgress === 0) {
      redeemSlider.setAttribute('aria-valuetext', '0 percent. Complete the staff confirmation first.');
    }
  }

  function resetRedeemSlider() {
    redeemDragging = false;
    redeemPointerId = null;
    redeemPointerStartX = 0;
    redeemPointerMoved = false;
    redeemSlider.classList.remove('is-dragging', 'is-complete', 'is-submitting');
    setRedeemProgress(0);
  }

  function setRedeemBusy(busy) {
    redeemInFlight = busy;
    redeemSlider.classList.toggle('is-submitting', busy);
    redeemSlider.setAttribute('aria-disabled', busy ? 'true' : 'false');
    cancelRedeem.disabled = busy;
    cancelRedeemTop.disabled = busy;
    if (!busy) updateRedeemAvailability();
  }

  function closeModal(force) {
    if (redeemInFlight && !force) return;
    setRedeemBusy(false);
    modal.hidden = true;
    groupCheck.checked = false;
    promotionCheck.checked = false;
    redeemStatus.textContent = '';
    resetRedeemSlider();
    updateRedeemAvailability();
  }

  function openModal() {
    if (currentState !== 'ACTIVE' || !currentCouponId || redeemInFlight) return;
    modal.hidden = false;
    groupCheck.checked = false;
    promotionCheck.checked = false;
    redeemStatus.textContent = '';
    resetRedeemSlider();
    updateRedeemAvailability();
    window.setTimeout(function () { groupCheck.focus(); }, 0);
  }

  function playRedeemClick() {
    try {
      if (navigator.vibrate) navigator.vibrate(18);
    } catch {}
    try {
      var AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextConstructor) return;
      if (!redeemAudioContext) redeemAudioContext = new AudioContextConstructor();
      var context = redeemAudioContext;
      var start = context.currentTime;
      var oscillator = context.createOscillator();
      var gain = context.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(520, start);
      oscillator.frequency.exponentialRampToValueAtTime(220, start + .06);
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.exponentialRampToValueAtTime(.035, start + .004);
      gain.gain.exponentialRampToValueAtTime(.0001, start + .075);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + .075);
      if (context.state === 'suspended') context.resume().catch(function () {});
    } catch {}
  }

  function setRedeemError(message) {
    setRedeemBusy(false);
    resetRedeemSlider();
    redeemStatus.textContent = message || 'Could not confirm. Please try again.';
    updateRedeemAvailability();
  }

  async function reconcileAfterFailure() {
    redeemStatus.textContent = 'Checking redemption status…';
    try {
      var result = await request({ action: 'status', device_id: deviceId });
      if (result.data.status === 'REDEEMED' || (result.data.status === 'LOCKED' && result.data.redeemed_at)) {
        setRedeemBusy(false);
        showRedeemed(result.data);
        return;
      }
      if (result.data.status === 'LOCKED') {
        setRedeemBusy(false);
        showLocked(result.data);
        return;
      }
      if (result.data.status === 'ACTIVE' && result.data.coupon_id) {
        showActive(result.data);
      }
    } catch {}
    setRedeemError('Could not confirm. Please try again.');
  }

  async function redeem() {
    if (redeemInFlight || currentState !== 'ACTIVE' || !currentCouponId || !deviceId ||
      !groupCheck.checked || !promotionCheck.checked) return;

    setRedeemProgress(1);
    redeemSlider.classList.add('is-complete');
    playRedeemClick();
    setRedeemBusy(true);
    redeemStatus.textContent = 'Confirming…';
    try {
      var result = await request({
        action: 'redeem', device_id: deviceId, coupon_id: currentCouponId,
        staff_action_id: makeUuid(), group_confirmed: groupCheck.checked,
        no_other_promotion: promotionCheck.checked
      });
      if (result.data.status === 'REDEEMED') {
        setRedeemBusy(false);
        showRedeemed(result.data);
        return;
      }
      if (result.data.status === 'ALREADY_REDEEMED' || result.data.error === 'ALREADY_REDEEMED') {
        setRedeemBusy(false);
        if (result.data.redeemed_at) showRedeemed(result.data);
        else showLocked(result.data);
        return;
      }
      if (result.data.status === 'REVIEW_REQUIRED' || result.data.error === 'REVIEW_REQUIRED') {
        setRedeemError('Please complete the staff confirmation and try again.');
        return;
      }
      await reconcileAfterFailure();
    } catch {
      await reconcileAfterFailure();
    }
  }

  function releaseRedeemPointer() {
    if (!redeemDragging) return;
    redeemDragging = false;
    redeemSlider.classList.remove('is-dragging');
    if (redeemPointerMoved && redeemProgress >= redeemThreshold) redeem();
    else setRedeemProgress(0);
    redeemPointerId = null;
    redeemPointerStartX = 0;
    redeemPointerMoved = false;
  }

  async function loadStatus() {
    deviceId = getDeviceId();
    if (!apiUrl || !deviceId) {
      showUnavailable('Reward status could not be verified.');
      return;
    }
    try {
      var result = await request({ action: 'status', device_id: deviceId });
      if (result.data.status === 'ACTIVE' && result.data.coupon_id) showActive(result.data);
      else if (result.data.status === 'LOCKED' && result.data.redeemed_at) showRedeemed(result.data);
      else if (result.data.status === 'LOCKED') showLocked(result.data);
      else if (result.data.status === 'REDEEMED') showRedeemed(result.data);
      else showUnavailable('Reward status could not be verified.');
    } catch {
      showUnavailable('Reward status could not be verified.');
    }
  }

  markUsed.addEventListener('click', openModal);
  cancelRedeem.addEventListener('click', function () { closeModal(false); });
  cancelRedeemTop.addEventListener('click', function () { closeModal(false); });
  groupCheck.addEventListener('change', updateRedeemAvailability);
  promotionCheck.addEventListener('change', updateRedeemAvailability);
  retryStatus.addEventListener('click', loadStatus);
  modal.addEventListener('click', function (event) { if (event.target === modal) closeModal(false); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) closeModal(false);
  });

  redeemSlider.addEventListener('pointerdown', function (event) {
    if (redeemInFlight || redeemSlider.getAttribute('aria-disabled') === 'true') return;
    var rect = redeemSlider.getBoundingClientRect();
    var thumbSize = redeemThumb ? redeemThumb.offsetWidth : 50;
    var maxX = Math.max(0, rect.width - thumbSize - 8);
    var thumbCenter = rect.left + 4 + thumbSize / 2 + maxX * redeemProgress;
    if (Math.abs(event.clientX - thumbCenter) > Math.max(28, thumbSize * .9)) return;
    redeemDragging = true;
    redeemPointerId = event.pointerId;
    redeemPointerStartX = event.clientX;
    redeemPointerMoved = false;
    redeemSlider.classList.add('is-dragging');
    redeemSlider.setPointerCapture(event.pointerId);
    setRedeemProgress(progressFromClientX(event.clientX));
    event.preventDefault();
  });

  redeemSlider.addEventListener('pointermove', function (event) {
    if (!redeemDragging || event.pointerId !== redeemPointerId || redeemInFlight) return;
    if (Math.abs(event.clientX - redeemPointerStartX) >= 8) redeemPointerMoved = true;
    setRedeemProgress(progressFromClientX(event.clientX));
    event.preventDefault();
  });
  redeemSlider.addEventListener('pointerup', releaseRedeemPointer);
  redeemSlider.addEventListener('pointercancel', releaseRedeemPointer);
  redeemSlider.addEventListener('lostpointercapture', function () {
    if (redeemDragging) releaseRedeemPointer();
  });

  redeemSlider.addEventListener('keydown', function (event) {
    if (redeemInFlight || redeemSlider.getAttribute('aria-disabled') === 'true') return;
    var step = event.shiftKey ? .2 : .1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      setRedeemProgress(redeemProgress + step);event.preventDefault();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      setRedeemProgress(redeemProgress - step);event.preventDefault();
    } else if (event.key === 'Home') {
      setRedeemProgress(0);event.preventDefault();
    } else if (event.key === 'End') {
      setRedeemProgress(1);event.preventDefault();
    }
    if (redeemProgress >= redeemThreshold) redeem();
  });

  window.addEventListener('resize', function () { setRedeemProgress(redeemProgress); });
  setRedeemProgress(0);
  updateRedeemAvailability();
  loadStatus();
})();
