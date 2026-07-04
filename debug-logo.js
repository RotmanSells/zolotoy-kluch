// Вставь в консоль на странице организации Яндекс.Карт
// Например: https://yandex.ru/maps/org/61797938783/

(function () {
  const results = {};

  // 1. DOM селекторы
  const domSelectors = [
    '.card-header-media-view__logo img',
    '.orgpage-header-view__logo img',
    '.business-card-title-view__logo img',
    '.logo-view__image',
    '.org-logo img',
    '[class*="logo"] img',
  ];
  for (const sel of domSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      results[`DOM: ${sel}`] = el.src || el.getAttribute('src');
    }
  }

  // 2. meta og:image
  const ogImage = document.querySelector('meta[property="og:image"]');
  if (ogImage) results['meta[og:image]'] = ogImage.content;

  // 3. JSON state — ищем все script с JSON
  const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');
  for (const script of scripts) {
    const text = script.textContent || '';
    if (!text.includes('logo')) continue;

    // Ищем logo блок
    const logoMatch = text.match(/"logo"\s*:\s*\{([^}]{0,500})\}/);
    if (logoMatch) {
      results['JSON: logo block'] = logoMatch[0].slice(0, 300);
    }

    // Ищем urlTemplate в logo
    const tmplMatch = text.match(/"logo"\s*:\s*\{[^}]*"urlTemplate"\s*:\s*"([^"]+)"/);
    if (tmplMatch) {
      results['JSON: logo.urlTemplate'] = tmplMatch[1];
    }

    // Ищем url в logo
    const urlMatch = text.match(/"logo"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/);
    if (urlMatch) {
      results['JSON: logo.url'] = urlMatch[1];
    }

    // Ищем src в logo
    const srcMatch = text.match(/"logo"\s*:\s*\{[^}]*"src"\s*:\s*"([^"]+)"/);
    if (srcMatch) {
      results['JSON: logo.src'] = srcMatch[1];
    }

    // vendorLogo
    const vLogoMatch = text.match(/"vendorLogo"\s*:\s*\{[^}]*"urlTemplate"\s*:\s*"([^"]+)"/);
    if (vLogoMatch) {
      results['JSON: vendorLogo.urlTemplate'] = vLogoMatch[1];
    }

    // orgInfo
    const orgInfoMatch = text.match(/"orgInfo"\s*:\s*\{[^}]*"logo"\s*:\s*\{([^}]{0,500})\}/);
    if (orgInfoMatch) {
      results['JSON: orgInfo.logo'] = orgInfoMatch[0].slice(0, 300);
    }

    // contactsLogo
    const clMatch = text.match(/"contactsLogo"\s*:\s*\{([^}]{0,300})\}/);
    if (clMatch) {
      results['JSON: contactsLogo'] = clMatch[0].slice(0, 300);
    }

    // Ищем ВСЕ urlTemplate рядом с "logo"
    const allTmpl = [...text.matchAll(/"logo"[^}]*"urlTemplate"\s*:\s*"([^"]+)"/g)];
    if (allTmpl.length) {
      results[`JSON: all logo urlTemplate (${allTmpl.length})`] = allTmpl.map(m => m[1]).join(' | ');
    }
  }

  // 4. Ищем в window.__PRELOADED_STATE__ или аналогах
  for (const key of Object.keys(window)) {
    if (key.startsWith('__') && typeof window[key] === 'object') {
      try {
        const str = JSON.stringify(window[key]).slice(0, 50000);
        if (str.includes('urlTemplate')) {
          const m = str.match(/"logo"\s*:\s*\{[^}]*"urlTemplate"\s*:\s*"([^"]+)"/);
          if (m) results[`window.${key} logo`] = m[1];
        }
      } catch {}
    }
  }

  console.table(Object.entries(results).map(([k, v]) => ({ Источник: k, Значение: String(v || 'НЕТ').slice(0, 120) })));
  return results;
})();
