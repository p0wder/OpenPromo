/**
 * SanMar's fixed lists, from its Purchase Order Integration Guide v24.6 and
 * Web Services Integration Guide v24.7 (Oct 2026).
 */

/** SanMar's warehouses: number (whseNo, PromoStandards fobId), will-call code, location. */
export const SANMAR_WAREHOUSES = [
  { id: "1", code: "PRE", name: "Seattle, WA" },
  { id: "2", code: "CIN", name: "Cincinnati, OH" },
  { id: "3", code: "COP", name: "Dallas, TX" },
  { id: "4", code: "REN", name: "Reno, NV" },
  { id: "5", code: "NJE", name: "Robbinsville, NJ" },
  { id: "6", code: "JAC", name: "Jacksonville, FL" },
  { id: "7", code: "MSP", name: "Minneapolis, MN" },
  { id: "12", code: "PHX", name: "Phoenix, AZ" },
  { id: "31", code: "VA1", name: "Richmond, VA" },
] as const;

/** Ship methods SanMar's own PO service takes in `shipMethod`. */
export const SANMAR_SHIP_METHODS = [
  { code: "UPS", label: "UPS Ground" },
  { code: "UPS 2ND DAY", label: "UPS 2nd Day (end of day)" },
  { code: "UPS 2ND DAY AM", label: "UPS 2nd Day (10:30 am)" },
  { code: "UPS 3RD DAY", label: "UPS 3 Day Select" },
  { code: "UPS NEXT DAY", label: "UPS Next Day (10:30 am)" },
  { code: "UPS NEXT DAY EA", label: "UPS Next Day Early (8:00 am)" },
  { code: "UPS NEXT DAY SV", label: "UPS Next Day Saver (3:00 pm)" },
  { code: "UPS SATURDAY", label: "UPS Saturday delivery" },
  { code: "USPS PP", label: "USPS Ground Advantage" },
  { code: "USPS APP", label: "USPS Priority Mail" },
  { code: "PSST", label: "PSST (Pack Separately. Ship Together.)" },
  { code: "TRUCK", label: "Truck (required over 500 lb)" },
] as const;

/** Field limits on SanMar's PO service (characters). */
export const SANMAR_PO_LIMITS = {
  poNum: 28,
  attention: 35,
  notes: 100,
  shipTo: 28,
  address: 35,
  city: 28,
  state: 2,
  email: 105,
  shipMethod: 15,
  color: 50,
  size: 50,
  style: 60,
  quantity: 999_999,
} as const;
