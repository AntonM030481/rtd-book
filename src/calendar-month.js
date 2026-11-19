// Self-contained so Playwright can evaluate it in the calendar frame.
// Read the displayed month, never the selected date or hidden range fields:
// the date picker can display a different month from the selected week.
export function readCalendarMonth(root = document) {
  const normalize = text => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replaceAll('ς', 'σ').replace(/[\u200b-\u200f\u2060\ufeff]/g, '').trim();
  const names = [
    ['january', 'jan', 'ιανουαριος', 'ιανουαριου'],
    ['february', 'feb', 'φεβρουαριος', 'φεβρουαριου'],
    ['march', 'mar', 'μαρτιος', 'μαρτιου'],
    ['april', 'apr', 'απριλιος', 'απριλιου'],
    ['may', 'μαιος', 'μαιου'],
    ['june', 'jun', 'ιουνιος', 'ιουνιου'],
    ['july', 'jul', 'ιουλιος', 'ιουλιου'],
    ['august', 'aug', 'αυγουστος', 'αυγουστου'],
    ['september', 'sep', 'sept', 'σεπτεμβριος', 'σεπτεμβριου'],
    ['october', 'oct', 'οκτωβριος', 'οκτωβριου'],
    ['november', 'nov', 'νοεμβριος', 'νοεμβριου'],
    ['december', 'dec', 'δεκεμβριος', 'δεκεμβριου'],
  ];
  const months = new Map(names.flatMap((aliases, index) => aliases.map(name => [normalize(name), index])));
  const parse = text => {
    const value = normalize(text);
    const forward = /^([a-zα-ω]+)\.?\s*(\d{4})$/u.exec(value);
    const reverse = /^(\d{4})\s*([a-zα-ω]+)\.?$/u.exec(value);
    const name = forward?.[1] ?? reverse?.[2];
    const year = forward?.[2] ?? reverse?.[1];
    return months.has(name) ? Number(year) * 12 + months.get(name) : null;
  };
  const arrows = root.querySelectorAll('img[src$="dlcalendar_nextmonth_black.gif"], img[src$="dlcalendar_prevmonth_black.gif"]');
  const scopes = [...new Set([...arrows].map(arrow => arrow.closest('table')).filter(Boolean))];
  const found = new Set();
  const add = text => { const month = parse(text); if (month !== null) found.add(month); };
  const scan = scope => {
    for (const cell of scope.querySelectorAll('td,th')) {
      if (!cell.querySelector('table')) add(cell.textContent);
    }
    // Some layouts render the month and year in separate cells. Joining only
    // direct leaf cells avoids flattening the surrounding page's layout tables.
    for (const row of scope.querySelectorAll('tr')) {
      const cells = [...row.children].filter(cell => /^(TD|TH)$/.test(cell.tagName));
      if (cells.length && cells.every(cell => !cell.querySelector('table'))) {
        add(cells.map(cell => cell.textContent).join(' '));
        for (let index = 0; index < cells.length - 1; index++) {
          add(`${cells[index].textContent} ${cells[index + 1].textContent}`);
        }
      }
    }
  };
  for (const scope of scopes) scan(scope);
  // Navigation arrows may live in their own nested table, outside the heading.
  if (!found.size) scan(root);
  // Conflicting month labels must not select an arbitrary calendar.
  return found.size === 1 ? [...found][0] : null;
}
