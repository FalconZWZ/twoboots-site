/* Swatch colours guessed from a product's colour name; shared by the storefront and the admin.
   More specific stems go first: "тёмно-син" before "син", "черничн" before "черн". */
(function () {
  const COLOR_HEX = [
    ['серебр', '#c9ccd1'], ['графит', '#4a4f55'], ['черничн', '#4f3a6b'], ['черн', '#1b1b1b'],
    ['слонов', '#f4efe0'], ['айвори', '#f4efe0'], ['молочн', '#f5f0e1'], ['кремов', '#f3e5ab'], ['бел', '#ffffff'],
    ['стальн', '#8a9199'], ['металлик', '#a8adb3'], ['хром', '#d6d9dc'], ['сер', '#9ea3a8'],
    ['фукси', '#c154c1'], ['маджент', '#d81b60'], ['пурпур', '#9c2780'], ['малин', '#c2185b'], ['вишн', '#8e1b3a'],
    ['винн', '#722f37'], ['марсал', '#964f4c'], ['бордов', '#7b1e3a'], ['рубин', '#b0123b'],
    ['ярко-розов', '#ff4f9a'], ['пудров', '#e8c4c4'], ['розов', '#f06292'], ['лосос', '#fa8072'],
    ['коралл', '#ff7f50'], ['терракот', '#c8603c'], ['красн', '#e53935'], ['алый', '#ff2400'], ['алая', '#ff2400'],
    ['персик', '#ffb38a'], ['абрикос', '#fbb46e'], ['мандарин', '#ff8a1f'], ['апельсин', '#fb8c00'], ['оранж', '#fb8c00'], ['рыж', '#d9661f'],
    ['лимон', '#fff44f'], ['горчич', '#d4a017'], ['желт', '#fdd835'], ['золот', '#d4af37'],
    ['песочн', '#d8c08f'], ['беж', '#d8c3a5'], ['карамел', '#c68e17'], ['капучин', '#a67b5b'], ['кофе', '#6f4e37'],
    ['шоколад', '#5c3a21'], ['коричн', '#795548'], ['бронз', '#b0773a'], ['медн', '#b87333'],
    ['фисташ', '#a8c97f'], ['салат', '#9ccc65'], ['лайм', '#9bd22e'], ['мят', '#98d8c8'], ['оливк', '#7a7f2b'],
    ['хаки', '#78866b'], ['изумруд', '#1f8a5b'], ['темно-зелен', '#1b5e20'], ['зелен', '#2e9e4f'],
    ['аквамарин', '#5fd3c4'], ['морск', '#2a9d8f'], ['бирюз', '#26a69a'], ['небесн', '#87ceeb'], ['голуб', '#64b5f6'],
    ['василь', '#6495ed'], ['джинс', '#3b5b8c'], ['темно-син', '#1a237e'], ['ультрамарин', '#3f00ff'], ['сапфир', '#0f52ba'],
    ['индиго', '#4b0082'], ['син', '#1e3a8a'], ['лаванд', '#b39ddb'], ['сирен', '#b39ddb'], ['лилов', '#a066c4'],
    ['баклажан', '#614051'], ['сливов', '#8e4585'], ['фиолет', '#7e3fb0'],
    ['радуж', 'conic-gradient(#e53935,#fdd835,#2e9e4f,#1e88e5,#7e3fb0,#e53935)'],
    ['мульти', 'conic-gradient(#e53935,#fdd835,#2e9e4f,#1e88e5,#7e3fb0,#e53935)'],
    ['голограф', 'conic-gradient(#f8bbd0,#b3e5fc,#c8e6c9,#fff9c4,#e1bee7,#f8bbd0)'],
    ['перламутр', 'linear-gradient(135deg,#fdfbf7,#e9e4f0,#f6efe6)'],
    ['прозрачн', 'linear-gradient(135deg,#ffffff 45%,#dfe6ec 55%)'],
    ['black', '#1b1b1b'], ['white', '#ffffff'], ['grey', '#9ea3a8'], ['gray', '#9ea3a8'], ['silver', '#c9ccd1'],
    ['gold', '#d4af37'], ['pink', '#f06292'], ['red', '#e53935'], ['orange', '#fb8c00'], ['yellow', '#fdd835'],
    ['green', '#2e9e4f'], ['blue', '#1e3a8a'], ['purple', '#7e3fb0'], ['violet', '#7e3fb0'],
  ];
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();
  const lookup = name => { const c = norm(name); const hit = COLOR_HEX.find(([k]) => c.includes(k)); return hit ? hit[1] : null; };
  // "Чёрно-белый", "розово-голубой", "синий/жёлтый" → a half-and-half circle
  function twoTone(name) {
    const parts = norm(name).split(/\s*(?:\/|\+|,|\sи\s|-)\s*/).filter(Boolean);
    if (parts.length !== 2) return null;
    const stem = s => s.replace(/о$/, '');
    const a = lookup(stem(parts[0])), b = lookup(parts[1]);
    if (!a || !b || a === b || a.includes('gradient') || b.includes('gradient')) return null;
    return `linear-gradient(135deg,${a} 50%,${b} 50%)`;
  }
  window.colorFromName = name => (norm(name) ? twoTone(name) || lookup(name) : null);
  // A colour typed in the admin: #rgb / #rrggbb only, so it is safe inside a style attribute
  window.safeHex = v => (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v || '').trim()) ? String(v).trim() : null);
})();
