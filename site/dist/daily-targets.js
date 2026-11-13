(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DAILY_TARGETS = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TZ = 'America/Sao_Paulo';

  /** Convert DD/MM/YYYY to YYYY-MM-DD, returning null when invalid. */
  function brDateToIso(brDate) {
    const match = String(brDate || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return null;
    return `${match[3]}-${match[2]}-${match[1]}`;
  }

  /** Convert YYYY-MM-DD to DD/MM/YYYY, preserving non-ISO strings. */
  function isoToBrDate(isoDate) {
    const match = String(isoDate || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return String(isoDate || '');
    return `${match[3]}/${match[2]}/${match[1]}`;
  }

  /** Format a Date or timestamp as YYYY-MM-DD in America/Sao_Paulo. */
  function brDateIso(value = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date(value));
    const map = {};
    for (const part of parts) map[part.type] = part.value;
    return `${map.year}-${map.month}-${map.day}`;
  }

  /** Normalize an ISO date, BR date, or Date instance to YYYY-MM-DD in America/Sao_Paulo. */
  function normalizeDateKey(dateInput) {
    if (dateInput === undefined || dateInput === null || dateInput === '') {
      return brDateIso();
    }
    if (dateInput instanceof Date) {
      return Number.isNaN(dateInput.getTime()) ? null : brDateIso(dateInput);
    }
    const text = String(dateInput).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    return brDateToIso(text);
  }

  /** Official daily GMV targets (BRL) for November 2026. */
  const DAILY_TARGETS_SCHEDULE = Object.freeze([
    { data: '01/11/2026', dia: 'Domingo', meta: 82613 },
    { data: '02/11/2026', dia: 'Segunda-feira', meta: 139942 },
    { data: '03/11/2026', dia: 'Terça-feira', meta: 262832 },
    { data: '04/11/2026', dia: 'Quarta-feira', meta: 252939 },
    { data: '05/11/2026', dia: 'Quinta-feira', meta: 251419 },
    { data: '06/11/2026', dia: 'Sexta-feira', meta: 210552 },
    { data: '07/11/2026', dia: 'Sábado', meta: 114005 },
    { data: '08/11/2026', dia: 'Domingo', meta: 118019 },
    { data: '09/11/2026', dia: 'Segunda-feira', meta: 234051 },
    { data: '10/11/2026', dia: 'Terça-feira', meta: 262832 },
    { data: '11/11/2026', dia: 'Quarta-feira', meta: 671585 },
    { data: '12/11/2026', dia: 'Quinta-feira', meta: 251419 },
    { data: '13/11/2026', dia: 'Sexta-feira', meta: 210552 },
    { data: '14/11/2026', dia: 'Sábado', meta: 114005 },
    { data: '15/11/2026', dia: 'Domingo', meta: 82613 },
    { data: '16/11/2026', dia: 'Segunda-feira', meta: 234051 },
    { data: '17/11/2026', dia: 'Terça-feira', meta: 262832 },
    { data: '18/11/2026', dia: 'Quarta-feira', meta: 252939 },
    { data: '19/11/2026', dia: 'Quinta-feira', meta: 251419 },
    { data: '20/11/2026', dia: 'Sexta-feira', meta: 147387 },
    { data: '21/11/2026', dia: 'Sábado', meta: 114005 },
    { data: '22/11/2026', dia: 'Domingo', meta: 118019 },
    { data: '23/11/2026', dia: 'Segunda-feira', meta: 234051 },
    { data: '24/11/2026', dia: 'Terça-feira', meta: 262832 },
    { data: '25/11/2026', dia: 'Quarta-feira', meta: 252939 },
    { data: '26/11/2026', dia: 'Quinta-feira', meta: 251419 },
    { data: '27/11/2026', dia: 'Sexta-feira', meta: 392660 },
    { data: '28/11/2026', dia: 'Sábado', meta: 114005 },
    { data: '29/11/2026', dia: 'Domingo', meta: 118019 },
    { data: '30/11/2026', dia: 'Segunda-feira', meta: 234051 }
  ].map(entry => Object.freeze({ ...entry, isoDate: brDateToIso(entry.data) })));

  const TARGETS_BY_ISO = new Map(DAILY_TARGETS_SCHEDULE.map(entry => [entry.isoDate, entry]));

  /** Look up the target record for a given date (defaults to current BRT date). */
  function getDailyTargetEntry(dateInput) {
    const key = normalizeDateKey(dateInput);
    return key ? (TARGETS_BY_ISO.get(key) || null) : null;
  }

  /** Return the numeric daily GMV target for a date, or null when unconfigured. */
  function getDailyTargetValue(dateInput) {
    const entry = getDailyTargetEntry(dateInput);
    return entry ? entry.meta : null;
  }

  return {
    TZ,
    DAILY_TARGETS_SCHEDULE,
    brDateIso,
    brDateToIso,
    isoToBrDate,
    normalizeDateKey,
    getDailyTargetEntry,
    getDailyTargetValue
  };
});

