/* =========================================================================
 * motif-price-loader.js
 * -------------------------------------------------------------------------
 * کافه موتیف — لودر قیمت از Google Sheets
 * -------------------------------------------------------------------------
 * Workflow:
 *   Google Sheet  →  File > Share > Publish to web  →  CSV URL
 *   سپس همان URL را در ثابت CONFIG.csvUrl جایگزین کنید.
 *
 *     Google Sheet → Published CSV URL → motif-price-loader.js → index.html
 *
 *   این فایل فقط یک‌بار روی GitHub منتشر می‌شود؛ پس از آن تغییرات قیمت
 *   یا فعال/غیرفعال‌کردن محصولات مستقیماً از شیت خوانده می‌شود و نیازی
 *   به آپلود مجدد HTML/JS نیست (مگر برای تغییر ساختار، ظاهر یا کد).
 * -------------------------------------------------------------------------
 * استفاده:
 *   ۱) در index.html قبل از بسته‌شدن </body> این خطوط را قرار دهید:
 *
 *      <script src="motif-price-loader.js"></script>
 *      <script>
 *        MotifPriceLoader.apply();
 *      </script>
 *
 *   ۲) ثابت csvUrl پایین را با URL انتشار CSV شیت خودتان جایگزین کنید.
 * ========================================================================= */

var MotifPriceLoader = (function () {
  'use strict';

  /* ============================== CONFIG ============================== */

  var CONFIG = {
    // آدرس خروجی CSV منتشرشده از Google Sheets را اینجا بگذارید:
    // قالب پیش‌فرض از "Publish to web" به‌شکل زیر است:
    // https://docs.google.com/spreadsheets/d/e/SPREADSHEET_ID/pub?gid=SHEET_GID&single=true&output=csv
    csvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTlPbSAGPPmOn2jK23XStOJCC5gVsherENSUBr4EGWwgeOUU39_FJ1CINa_nZk-Ss0QZejNTRBGwUhU/pub?output=csv',

    // نام ستون‌های موجود در شیت (قابل تنظیم):
    columnNames: {
      productId: 'product_id',
      categoryId: 'category_id',
      price: 'price',
      active: 'active',
      priceText: 'price_text',
      description: 'desc_fa',
      descriptionText: 'description_text',
      descriptionEn: 'desc_en'
    },

    // اگر true باشد، مقدار price_text (متن آماده) بر price عددی اولویت دارد.
    preferPriceText: true,

    // آیا محصولات active=false به‌کلی hide شوند یا فقط dim شوند؟
    hideInactive: true,

    // کلاس css اضافی برای آیتم‌های غیرفعال (زمانی‌که hideInactive=false).
    inactiveClass: 'is-inactive',

    // فرمت‌دهی عددی قیمت.
    numberFormat: 'fa-IR',
    numberStyle: 'decimal',
    currencySuffix: ' تومان',

    // آیا category/subcat که هیچ محصول فعالی ندارند هم مخفی شوند؟
    hideEmptySections: false,

    // کش کردن CSV در حافظه (برای جلوگیری از fetch تکراری).
    cache: true,

    // تایم‌اوت درخواست (میلی‌ثانیه).
    timeout: 8000
  };

  /* ============================== HELPERS ============================== */

  var cacheStore = null;

  function log() {
    if (typeof console !== 'undefined' && console && console.log) {
      console.log.apply(console, ['[MotifPriceLoader]'].concat(Array.prototype.slice.call(arguments)));
    }
  }

  function warn() {
    if (typeof console !== 'undefined' && console && console.warn) {
      console.warn.apply(console, ['[MotifPriceLoader]'].concat(Array.prototype.slice.call(arguments)));
    }
  }

  /* ---------------------------- CSV Parser ----------------------------
   * پارسر ساده و مقاوم که از فیلدهای quoted (شامل کاما و کوتیشن) پشتیبانی می‌کند.
   * -------------------------------------------------------------------- */
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var i = 0;
    var c;

    for (i = 0; i < text.length; i++) {
      c = text[i];

      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            // escaped quote
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else {
        if (c === '"') {
          inQuotes = true;
        } else if (c === ',') {
          row.push(field);
          field = '';
        } else if (c === '\n') {
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
        } else if (c !== '\r') {
          field += c;
        }
      }
    }

    // آخرین فیلد/ردیف در صورت نبودِ newline پایانی
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    return rows;
  }

  /* ------------------------ CSV → Array of Objects -------------------- */
  function csvToObjects(csvText) {
    var parsed = parseCsv(csvText);
    if (!parsed.length) return [];

    var header = parsed[0].map(function (h) {
      return String(h).trim();
    });

    return parsed.slice(1).map(function (line) {
      var obj = {};
      header.forEach(function (key, idx) {
        obj[key] = line[idx] !== undefined ? line[idx] : '';
      });
      return obj;
    });
  }

  /* --------------------------- Normalization -------------------------- */
  function normalize(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  function firstValue(record, keys) {
    for (var i = 0; i < keys.length; i++) {
      var value = normalize(record[keys[i]]);
      if (value !== '') return value;
    }
    return '';
  }

  function toBoolean(value) {
    var v = normalize(value).toLowerCase();
    if (v === 'false' || v === '0' || v === 'no' || v === 'off' || v === '') {
      return false;
    }
    return true; // true / 1 / yes / on / هر مقدار غیرخالی دیگر
  }

  /* ---------------------------- Price format -------------------------- */
  function formatPrice(value) {
    var num = Number(value);
    if (isNaN(num)) return '';

    var formatted;
    try {
      formatted = new Intl.NumberFormat(CONFIG.numberFormat, {
        style: CONFIG.numberStyle,
        maximumFractionDigits: 0
      }).format(num);
    } catch (e) {
      formatted = num.toLocaleString(CONFIG.numberFormat);
    }

    if (CONFIG.currencySuffix) {
      formatted += ' ' + CONFIG.currencySuffix;
    }
    return formatted;
  }

  /* ------------------------------ Apply ------------------------------- */

  function applyPriceToItem(item, record) {
    var col = CONFIG.columnNames;

    // قیمت متنی (آماده) — در صورت فعال بودن preferPriceText اولویت دارد.
    var priceText = normalize(record[col.priceText]);
    var numericPrice = normalize(record[col.price]);

    var finalPrice;
    if (CONFIG.preferPriceText && priceText !== '') {
      finalPrice = priceText;
    } else if (numericPrice !== '' && !isNaN(Number(numericPrice))) {
      finalPrice = formatPrice(numericPrice);
    } else if (priceText !== '') {
      finalPrice = priceText;
    } else {
      finalPrice = null; // چیزی برای نمایش نیست؛ قیمت فعلی HTML حفظ می‌شود.
    }

    if (finalPrice !== null) {
      var priceEls = item.querySelectorAll('.price');
      Array.prototype.forEach.call(priceEls, function (el) {
        el.textContent = finalPrice;
      });
    }

    // توضیحات محصول از شیت خوانده می‌شود.
    // اولویت با description_text و سپس description است.
    var description = firstValue(record, [
      col.description,
      col.descriptionText,
      'desc_fa',
      'description',
      'description_text'
    ]);
    if (description !== '') {
      var descriptionEn = firstValue(record, [
        col.descriptionEn,
        'desc_en',
        'description_en'
      ]);
      var descriptionEls = item.querySelectorAll('.item-desc');
      Array.prototype.forEach.call(descriptionEls, function (el) {
        el.textContent = document.documentElement.lang === 'en' && descriptionEn !== ''
          ? descriptionEn
          : description;
        el.setAttribute('data-fa', description);
        el.setAttribute('data-loader-description', 'true');
        if (descriptionEn !== '') {
          el.setAttribute('data-en', descriptionEn);
        } else {
          el.setAttribute('data-en', description);
        }
      });
    }

    // وضعیت فعال/غیرفعال
    var active = toBoolean(record[col.active]);
    if (!active) {
      if (CONFIG.hideInactive) {
        item.style.display = 'none';
        item.setAttribute('data-inactive', 'true');
      } else {
        item.classList.add(CONFIG.inactiveClass);
        item.setAttribute('data-inactive', 'true');
      }
    } else {
      // اطمینان از نمایش در صورت فعال‌بودن
      if (CONFIG.hideInactive) {
        item.style.display = '';
      }
      item.classList.remove(CONFIG.inactiveClass);
      item.removeAttribute('data-inactive');
      item.setAttribute('data-active', 'true');
    }
  }

  function hideEmptySections() {
    if (!CONFIG.hideEmptySections) return;

    // زیردسته‌ها: اگر هیچ آیتم فعالی ندارند، مخفی شوند.
    var subcatCards = document.querySelectorAll('.card[data-subcat-id]');
    Array.prototype.forEach.call(subcatCards, function (card) {
      var visibleItems = Array.prototype.filter.call(
        card.querySelectorAll('.item[data-product-id]'),
        function (item) {
          return item.style.display !== 'none';
        }
      );
      if (visibleItems.length === 0) {
        card.style.display = 'none';
      }
    });

    // دسته‌ها: اگر هیچ زیردسته‌ای با محتوای فعالبقا نمانده، مخفی شوند.
    var sections = document.querySelectorAll('section.page[data-category-id]');
    Array.prototype.forEach.call(sections, function (section) {
      var visibleCards = Array.prototype.filter.call(
        section.querySelectorAll('.card[data-subcat-id]'),
        function (card) {
          return card.style.display !== 'none';
        }
      );
      if (visibleCards.length === 0) {
        section.style.display = 'none';
      }
    });
  }

  function categoryFromMenuLink(link) {
    var onclick = link.getAttribute('onclick') || '';
    var match = onclick.match(/goToCategory\(\s*['"]([^'"]+)['"]/);
    return match ? normalize(match[1]) : '';
  }

  function updateCategoryVisibility(records) {
    var col = CONFIG.columnNames;
    var activeByCategory = {};

    records.forEach(function (record) {
      var categoryId = normalize(record[col.categoryId]);
      if (!categoryId) return;
      if (!Object.prototype.hasOwnProperty.call(activeByCategory, categoryId)) {
        activeByCategory[categoryId] = false;
      }
      if (toBoolean(record[col.active])) {
        activeByCategory[categoryId] = true;
      }
    });

    var visibleCategories = [];
    var sections = document.querySelectorAll('section.page[data-category-id]');
    Array.prototype.forEach.call(sections, function (section) {
      var categoryId = normalize(section.getAttribute('data-category-id'));
      var isVisible = activeByCategory[categoryId] === true;
      section.style.display = isVisible ? '' : 'none';

      var categoryButton = document.getElementById(categoryId + 'Btn');
      if (categoryButton) {
        categoryButton.style.display = isVisible ? '' : 'none';
      }

      var menuLinks = document.querySelectorAll('.menu-link');
      Array.prototype.forEach.call(menuLinks, function (link) {
        if (categoryFromMenuLink(link) === categoryId) {
          link.style.display = isVisible ? '' : 'none';
        }
      });

      if (isVisible) {
        visibleCategories.push(categoryId);
      }
    });

    var activeSection = document.querySelector('section.page.active[data-category-id]');
    if ((!activeSection || activeSection.style.display === 'none') && visibleCategories.length) {
      if (typeof showPage === 'function') {
        showPage(visibleCategories[0]);
      }
    }
  }

  function applyToDom(records) {
    var col = CONFIG.columnNames;
    var index = {};
    records.forEach(function (r) {
      var key = normalize(r[col.productId]);
      if (key) index[key] = r;
    });

    var applied = 0;
    var items = document.querySelectorAll('.item[data-product-id]');
    Array.prototype.forEach.call(items, function (item) {
      var pid = normalize(item.getAttribute('data-product-id'));
      if (pid && index[pid]) {
        applyPriceToItem(item, index[pid]);
        applied++;
      }
    });

    hideEmptySections();
    updateCategoryVisibility(records);
    var descriptionsApplied = document.querySelectorAll('.item-desc[data-loader-description="true"]').length;
    log('تعداد محصولات به‌روزرسانی‌شده:', applied, 'از', items.length, '— توضیحات:', descriptionsApplied);
    return applied;
  }

  /* ------------------------------ Fetch ------------------------------- */

  function fetchCsv(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var timedOut = false;
      var timer = setTimeout(function () {
        timedOut = true;
        xhr.abort();
        reject(new Error('timeout'));
      }, CONFIG.timeout);

      xhr.open('GET', url, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4 || timedOut) return;
        clearTimeout(timer);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.responseText);
        } else {
          reject(new Error('HTTP ' + xhr.status));
        }
      };
      xhr.onerror = function () {
        clearTimeout(timer);
        reject(new Error('network error'));
      };
      xhr.send();
    });
  }

  /* ---------------------------- Main entry -----------------------------
   * 1) اگر کش موجود است، مستقیم همان را اعمال کن.
   * 2) در غیر این صورت CSV را fetch کن، parse کن و اعمال کن.
   * 3) در صورت هر خطا، صفحه به‌صورت static (با قیمت‌های HTML فعلی)
   *    باقی می‌ماند تا سایت هرگز از کار نیفتد.
   * -------------------------------------------------------------------- */
  function apply(options) {
    var cfg = CONFIG;
    if (options) {
      if (options.csvUrl) cfg.csvUrl = options.csvUrl;
      if (options.columnNames) {
        for (var k in options.columnNames) {
          cfg.columnNames[k] = options.columnNames[k];
        }
      }
      if (typeof options.preferPriceText === 'boolean') cfg.preferPriceText = options.preferPriceText;
      if (typeof options.hideInactive === 'boolean') cfg.hideInactive = options.hideInactive;
      if (typeof options.hideEmptySections === 'boolean') cfg.hideEmptySections = options.hideEmptySections;
    }

    if (!cfg.csvUrl || cfg.csvUrl.indexOf('PASTE_YOUR') === 0) {
      warn('csvUrl هنوز تنظیم نشده است. لطفاً URL انتشار CSV شیت را در CONFIG.csvUrl قرار دهید.');
      return Promise.resolve(0);
    }

    if (CONFIG.cache && cacheStore) {
      return Promise.resolve(applyToDom(cacheStore));
    }

    var requestUrl = cfg.csvUrl + (cfg.csvUrl.indexOf('?') >= 0 ? '&' : '?') + '_motif_ts=' + Date.now();

    return fetchCsv(requestUrl)
      .then(function (text) {
        var records = csvToObjects(text);
        if (!records.length) {
          warn('CSV خالی است یا هدر مناسبی ندارد.');
          return 0;
        }
        if (CONFIG.cache) cacheStore = records;
        return applyToDom(records);
      })
      .catch(function (err) {
        warn('خطا در دریافت/پردازش CSV:', err && err.message ? err.message : err);
        warn('صفحه بدون تغییر (static) باقی ماند.');
        return 0;
      });
  }

  /* ------------------------------ Expose ------------------------------ */
  return {
    apply: apply,
    config: CONFIG,
    parseCsv: parseCsv,
    csvToObjects: csvToObjects
  };
})();

// اگر صفحه به‌طور خودکار این اسکریپت را لود کرد، بلافاصله اعمال کن.
if (typeof document !== 'undefined' && document.readyState !== 'loading') {
  MotifPriceLoader.apply();
} else if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', function () {
    MotifPriceLoader.apply();
  });
}
