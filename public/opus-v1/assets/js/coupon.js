/* Anonymous coupon status and staff-only redemption client. Server is authoritative. */
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
  var modal = document.getElementById('staffModal');
  var groupCheck = document.getElementById('groupCheck');
  var promotionCheck = document.getElementById('promotionCheck');
  var staffCode = document.getElementById('staffCode');
  var staffError = document.getElementById('staffError');
  var confirmRedeem = document.getElementById('confirmRedeem');
  var redeemedAt = document.getElementById('redeemedAt');
  var availableAgainAt = document.getElementById('availableAgainAt');
  var retryStatus = document.getElementById('retryStatus');
  if (!body || !offer || !markUsed || !modal) return;

  var apiUrl = body.getAttribute('data-coupon-api-url') || '';
  var apiKey = body.getAttribute('data-coupon-api-key') || '';
  var deviceStorageKey = 'machida_coupon_device_id';
  var deviceId = null;
  var currentCouponId = null;
  var currentState = 'checking';

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
  }

  function showLocked(detail) {
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
    reward.hidden = true;
    unavailable.hidden = true;
    redeemed.hidden = false;
    meta.hidden = true;
    markUsed.disabled = true;
    retryStatus.hidden = true;
    offer.dataset.couponState = 'REDEEMED';
    redeemedAt.textContent = formatDate(detail.redeemed_at, true);
    availableAgainAt.textContent = formatDate(detail.available_again_at, false);
    announceState('REDEEMED', detail);
  }

  async function request(payload) {
    var response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: apiKey },
      body: JSON.stringify(payload),
      cache: 'no-store',
      credentials: 'omit'
    });
    var data = {};
    try { data = await response.json(); } catch {}
    return { ok: response.ok, status: response.status, data: data };
  }

  async function loadStatus() {
    deviceId = getDeviceId();
    if (!apiUrl || !apiKey || !deviceId) {
      showUnavailable('Reward status could not be verified.');
      return;
    }
    try {
      var result = await request({ action: 'status', device_id: deviceId });
      if (result.data.status === 'ACTIVE' && result.data.coupon_id) showActive(result.data);
      else if (result.data.status === 'LOCKED') showLocked(result.data);
      else if (result.data.status === 'REDEEMED') showRedeemed(result.data);
      else showUnavailable('Reward status could not be verified.');
    } catch {
      showUnavailable('Reward status could not be verified.');
    }
  }

  function updateConfirmState() {
    confirmRedeem.disabled = !groupCheck.checked || !promotionCheck.checked || !staffCode.value.trim();
  }

  function closeModal() {
    modal.hidden = true;
    staffCode.value = '';
    staffError.textContent = '';
    updateConfirmState();
  }

  function openModal() {
    if (currentState !== 'ACTIVE' || !currentCouponId) return;
    modal.hidden = false;
    groupCheck.checked = false;
    promotionCheck.checked = false;
    staffCode.value = '';
    staffError.textContent = '';
    updateConfirmState();
    window.setTimeout(function () { staffCode.focus(); }, 0);
  }

  async function redeem() {
    if (confirmRedeem.disabled || currentState !== 'ACTIVE' || !currentCouponId || !deviceId) return;
    confirmRedeem.disabled = true;
    staffError.textContent = 'Verifying…';
    var submittedCode = staffCode.value;
    staffCode.value = '';
    try {
      var result = await request({
        action: 'redeem', device_id: deviceId, coupon_id: currentCouponId,
        staff_action_id: makeUuid(), staff_code: submittedCode,
        group_confirmed: groupCheck.checked, no_other_promotion: promotionCheck.checked
      });
      if (result.data.error === 'INVALID_STAFF_CODE') {
        staffError.textContent = 'Invalid staff code.';
        updateConfirmState();
        return;
      }
      if (result.data.error === 'STAFF_LOCKED') {
        staffError.textContent = 'Staff verification is temporarily locked. Try again later.';
        updateConfirmState();
        return;
      }
      if (result.data.error === 'ALREADY_REDEEMED') {
        closeModal();
        showLocked(result.data);
        return;
      }
      if (result.data.error === 'STAFF_VERIFICATION_REQUIRED') {
        closeModal();
        showUnavailable('Staff verification is currently unavailable.');
        return;
      }
      if (!result.ok || result.data.status !== 'REDEEMED') {
        staffError.textContent = 'Staff verification required. No redemption was made.';
        updateConfirmState();
        return;
      }
      currentCouponId = result.data.coupon_id || currentCouponId;
      closeModal();
      showRedeemed(result.data);
    } catch {
      staffError.textContent = 'Connection failed. No redemption was made.';
      updateConfirmState();
    }
  }

  markUsed.addEventListener('click', openModal);
  document.getElementById('cancelRedeem').addEventListener('click', closeModal);
  document.getElementById('cancelRedeemTop').addEventListener('click', closeModal);
  groupCheck.addEventListener('change', updateConfirmState);
  promotionCheck.addEventListener('change', updateConfirmState);
  staffCode.addEventListener('input', updateConfirmState);
  confirmRedeem.addEventListener('click', redeem);
  retryStatus.addEventListener('click', loadStatus);
  modal.addEventListener('click', function (event) { if (event.target === modal) closeModal(); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !modal.hidden) closeModal(); });

  loadStatus();
})();
