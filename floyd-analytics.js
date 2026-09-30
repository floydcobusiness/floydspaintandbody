/* Floyd analytics adapter. Loads PostHog only after an explicit visitor choice. */
(() => {
  'use strict';
  const config = window.FLOYD_POSTHOG_CONFIG;
  if (!config || !/^phc_[A-Za-z0-9]+$/.test(config.projectToken || '') || window.FloydPostHog) return;
  const hostname = location.hostname.replace(/^www\./, '');
  const site = config.sites?.[hostname];
  if (!site || !site.paths.some(pattern => new RegExp(pattern).test(location.pathname))) return;
  if (!['https://us.i.posthog.com', 'https://eu.i.posthog.com'].includes(config.apiHost)) return;
  const consentName = 'floyd_product_analytics';
  const idName = 'floyd_product_analytics_id';
  const revokeName = 'floyd_product_analytics_revoke';
  const cookie = name => document.cookie.split('; ').find(v => v.startsWith(name + '='))?.slice(name.length + 1);
  const setCookie = (name, value, seconds = 15552000) => {
    document.cookie = `${name}=${value}; Path=/; Max-Age=${seconds}; SameSite=Lax; Secure`;
  };
  const blocked = () => navigator.globalPrivacyControl === true || navigator.doNotTrack === '1';
  let enabled = cookie(consentName) === 'yes' && !blocked() && cookie(revokeName) !== '1';
  let ready = false, loading = false, observer;
  const viewed = new Set();
  const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value) ? value : undefined;
  const fields = ['token', 'site_id', 'environment', '$current_url', '$pathname', '$host', '$referrer', '$referring_domain',
    'distinct_id', '$session_id', '$window_id', '$lib', '$lib_version', '$browser', '$browser_version',
    '$os', '$os_version', '$device_type', '$screen_height', '$screen_width', '$viewport_height', '$viewport_width',
    '$process_person_profile', '$geoip_disable', 'product_id', 'variant_id', 'campaign_id', 'quantity',
    'value_cents', 'currency', 'link_kind', 'utm_source', 'utm_medium', 'utm_campaign'];
  function filter(event) {
    if (!enabled || blocked()) return null;
    const allowedEvents = ['$pageview', 'product_viewed', 'product_added_to_cart', 'checkout_started', 'contact_clicked'];
    if (!allowedEvents.includes(event.event)) return null;
    const properties = Object.fromEntries(Object.entries(event.properties || {}).filter(([key]) => fields.includes(key)));
    Object.assign(properties, {site_id: site.id, environment: config.environment || 'production', $current_url: location.origin + location.pathname,
      $pathname: location.pathname, $host: hostname, $process_person_profile: false, $geoip_disable: true});
    delete properties.$referrer; delete properties.$referring_domain;
    try { const ref = new URL(document.referrer); properties.$referring_domain = ref.hostname; } catch {}
    return {...event, properties};
  }
  function track(event, properties = {}) {
    if (!enabled || !ready || blocked()) return;
    try { window.posthog.capture(event, properties); } catch { /* Never interrupt shopping. */ }
  }
  function productProperties(product, variant, quantity = 1) {
    if (!safeId(product?.id) || !safeId(variant?.id) || !Number.isSafeInteger(variant.cents)
      || variant.cents < 0 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) return null;
    return {product_id: product.id, variant_id: variant.id, campaign_id: safeId(product.campaignId),
      quantity, value_cents: variant.cents * quantity, currency: 'USD'};
  }
  function observe() {
    observer?.disconnect();
    if (!('IntersectionObserver' in window)) return;
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !enabled || blocked()) continue;
        try {
          const product = JSON.parse(entry.target.querySelector('[data-product-config]').textContent);
          const variant = product.variants.find(v => v.id === entry.target.querySelector('[data-size]')?.value) || product.variants[0];
          const props = productProperties(product, variant);
          if (props && !viewed.has(product.id)) { track('product_viewed', props); viewed.add(product.id); observer.unobserve(entry.target); }
        } catch {}
      }
    }, {threshold: 0.15});
    document.querySelectorAll('[data-product]').forEach(card => observer.observe(card));
  }
  function init() {
    if (!enabled || blocked() || cookie(revokeName) === '1') return;
    if (ready) { window.posthog.opt_in_capturing({captureEventName: false}); observe(); return; }
    if (loading) return;
    loading = true;
    const script = document.createElement('script');
    script.src = '/posthog-1.435.1.no-external.js'; script.async = true;
    script.onerror = () => { loading = false; };
    script.onload = () => {
      loading = false;
      if (!enabled || blocked()) return;
      let id = cookie(idName);
      if (!/^[0-9a-f-]{36}$/.test(id || '')) { id = crypto.randomUUID(); setCookie(idName, id); }
      window.posthog.init(config.projectToken, {
        api_host: config.apiHost, defaults: '2026-05-30', bootstrap: {distinctID: id, isIdentifiedID: false},
        persistence: 'memory', person_profiles: 'never', autocapture: false, capture_pageview: false,
        capture_pageleave: false, capture_dead_clicks: false, rageclick: false,
        disable_session_recording: true, disable_surveys: true, capture_exceptions: false,
        capture_heatmaps: false, capture_performance: false, advanced_disable_flags: true,
        advanced_disable_feature_flags: true, disable_external_dependency_loading: true,
        save_referrer: false, save_campaign_params: false, ip: false, respect_dnt: true,
        before_send: filter,
        loaded: () => {
          ready = true;
          const params = new URLSearchParams(location.search), marketing = {};
          for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
            const value = params.get(key);
            if (value && /^[a-zA-Z0-9_. -]{1,100}$/.test(value)) marketing[key] = value;
          }
          track('$pageview', marketing); observe();
        },
      });
    };
    document.head.append(script);
  }
  window.FloydPostHog = Object.freeze({
    add(product, variant, quantity = 1) { const props = productProperties(product, variant, quantity); if (props) track('product_added_to_cart', props); },
    checkout(cart, review) {
      if (!ready || !enabled || !review?.canProceed || !Number.isSafeInteger(review.merchandiseCents)) return;
      try {
        const key = 'floyd_ph_checkout_' + cart.sessionId;
        if (sessionStorage.getItem(key)) return;
        track('checkout_started', {value_cents: review.merchandiseCents, currency: 'USD', quantity: cart.items.reduce((n, item) => n + item.quantity, 0)});
        sessionStorage.setItem(key, '1');
      } catch {}
    },
  });
  document.addEventListener('click', event => {
    const anchor = event.target.closest?.('a[href]');
    if (anchor?.getAttribute('href')?.startsWith('tel:')) track('contact_clicked', {link_kind: 'phone'});
    if (anchor?.getAttribute('href')?.startsWith('mailto:')) track('contact_clicked', {link_kind: 'email'});
  });
  const panel = document.createElement('section');
  panel.setAttribute('aria-label', 'Cookie preferences');
  panel.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;max-width:430px;margin:auto;padding:12px;border:1px solid #bbb;border-radius:12px;background:#fff;color:#222;box-shadow:0 4px 20px #0002;z-index:2000;font:14px/1.5 system-ui';
  const label = document.createElement('p');
  label.textContent = 'We use optional cookies to understand visits and improve your experience.';
  label.style.margin = '0 0 12px'; panel.append(label);
  const controls = document.createElement('div'); controls.style.cssText = 'display:flex;gap:10px'; panel.append(controls);
  const manage = document.createElement('button'); manage.type = 'button'; manage.textContent = 'Cookie settings';
  manage.style.cssText = 'font:inherit;min-height:44px;padding:10px;background:transparent;color:inherit;border:0;text-decoration:underline;cursor:pointer';
  async function revokePending() {
    if (cookie(revokeName) !== '1') return;
    if (!site.revokeEndpoint) { setCookie(idName, '', 0); setCookie(revokeName, '', 0); return; }
    try {
      const response = await fetch(site.revokeEndpoint, {method: 'POST', credentials: 'same-origin', keepalive: true});
      if (response.ok) { setCookie(idName, '', 0); setCookie(revokeName, '', 0); }
    } catch {}
  }
  async function choose(yes) {
    panel.hidden = true; manage.focus();
    enabled = false;
    if (!yes || blocked()) {
      setCookie(consentName, 'no');
      if (cookie(idName)) setCookie(revokeName, '1');
      if (ready) window.posthog.opt_out_capturing();
      observer?.disconnect();
      await revokePending();
    } else {
      await revokePending();
      enabled = cookie(revokeName) !== '1';
      setCookie(consentName, enabled ? 'yes' : 'no');
      if (enabled && ready) { window.posthog.reset(); setCookie(idName, window.posthog.get_distinct_id()); }
      init();
    }
  }
  for (const [title, yes] of [['Accept cookies', true], ['No thanks', false]]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = title;
    button.style.cssText = 'flex:1;min-height:44px;font:inherit;padding:8px;border:1px solid #555;border-radius:6px;background:#fff;color:#222;cursor:pointer';
    button.disabled = yes && blocked(); button.addEventListener('click', () => { void choose(yes); }); controls.append(button);
  }
  manage.addEventListener('click', () => { panel.hidden = false; controls.querySelector('button:not(:disabled)')?.focus(); });
  document.body.append(panel); (document.querySelector('footer') || document.body).append(manage);
  panel.hidden = Boolean(cookie(consentName)) || blocked();
  if (blocked()) void choose(false); else { void revokePending(); init(); }
})();
