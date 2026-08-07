// Profit, break-even and price-suggestion math.
//
// Model of a resale:
//   invested cost  = acquisition_cost + sum(all refurbishment costs)
//   selling costs  = shipping you eat + marketplace fees on the sale price
//   net proceeds   = price - price*feeRate - flatFee - shipping
//   profit         = net proceeds - invested cost
//
// Break-even price is the sale price where profit == 0.
import { config } from '../config.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * @param {object} item   row from `items`
 * @param {Array}  costs  rows from `costs` for that item
 * @param {object} [opts]
 * @param {number|null} [opts.marketEstimate] estimated resale value (e.g. median sold comp)
 */
export function computeItemFinancials(item, costs = [], opts = {}) {
  // Quantity of identical units on this listing. Money fields (acquisition,
  // listing/sold price, shipping, fees, refurb costs) are treated as PER UNIT;
  // the invested/profit/revenue TOTALS below are scaled by quantity.
  const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));

  const acquisition = Number(item.acquisition_cost) || 0;
  const refurbCost = costs.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
  const unitInvested = acquisition + refurbCost;   // per unit
  const investedCost = unitInvested * quantity;    // total across all units

  const shipping = Number(item.shipping_cost) || 0;
  // Marketplace defaults come from runtime settings (Admin page) when supplied,
  // otherwise the .env config. A "local sale" (sold in person / to a friend)
  // waives marketplace fees entirely.
  const d = opts.defaults || {};
  const localSale = Boolean(item.local_sale);
  const feeRate = localSale ? 0 : item.fee_rate != null ? Number(item.fee_rate) : d.feeRate ?? config.defaultFeeRate;
  const flatFee = localSale ? 0 : item.flat_fee != null ? Number(item.flat_fee) : d.flatFee ?? config.defaultFlatFee;
  const targetMargin =
    item.target_margin != null ? Number(item.target_margin) : d.targetMargin ?? config.defaultTargetMargin;

  // Break-even and suggested prices are PER-UNIT list prices.
  const breakEvenPrice = (unitInvested + shipping + flatFee) / (1 - feeRate);
  const desiredProfit = targetMargin * unitInvested;
  const suggestedPrice = (unitInvested + shipping + flatFee + desiredProfit) / (1 - feeRate);

  // Per-unit profit at a given sale price.
  const unitProfitAt = (price) => {
    if (price == null || Number.isNaN(Number(price))) return null;
    const p = Number(price);
    return p * (1 - feeRate) - flatFee - shipping - unitInvested;
  };
  // Total profit across all units at a given per-unit sale price.
  const profitAt = (price) => {
    const u = unitProfitAt(price);
    return u == null ? null : u * quantity;
  };
  const marginAt = (price) => {
    const u = unitProfitAt(price);
    if (u == null || unitInvested === 0) return null;
    return u / unitInvested; // per-unit == total margin ratio
  };

  const listingPrice = item.listing_price != null ? Number(item.listing_price) : null;
  const soldPrice = item.sold_price != null ? Number(item.sold_price) : null;
  const marketEstimate = opts.marketEstimate != null ? Number(opts.marketEstimate) : null;

  // Realized profit only exists once the item is actually sold.
  const realizedProfit = item.status === 'sold' && soldPrice != null ? profitAt(soldPrice) : null;

  // Projected profit for unsold stock: prefer the seller's asking price,
  // otherwise fall back to a market estimate if one was supplied.
  let projectedProfit = null;
  let projectionBasis = null;
  if (item.status !== 'sold' && item.status !== 'scrapped') {
    if (listingPrice != null) {
      projectedProfit = profitAt(listingPrice);
      projectionBasis = 'listing_price';
    } else if (marketEstimate != null) {
      projectedProfit = profitAt(marketEstimate);
      projectionBasis = 'market_estimate';
    }
  }

  // "What is needed to turn a profit" — the gap from the current plan to break-even.
  const referencePrice = listingPrice ?? marketEstimate ?? null;
  const amountToBreakEven =
    referencePrice != null ? round2(breakEvenPrice - referencePrice) : null;
  const profitableAtCurrentPlan =
    referencePrice != null ? referencePrice >= breakEvenPrice : null;

  return {
    quantity,
    unitInvested: round2(unitInvested),
    investedCost: round2(investedCost),
    acquisitionCost: round2(acquisition),
    refurbCost: round2(refurbCost),
    shipping: round2(shipping),
    feeRate,
    flatFee: round2(flatFee),
    localSale,
    targetMargin,
    breakEvenPrice: round2(breakEvenPrice),
    suggestedPrice: round2(suggestedPrice),
    listingPrice: listingPrice != null ? round2(listingPrice) : null,
    soldPrice: soldPrice != null ? round2(soldPrice) : null,
    // Total sale revenue across all units (per-unit sold price × quantity).
    realizedRevenue: soldPrice != null ? round2(soldPrice * quantity) : null,
    marketEstimate: marketEstimate != null ? round2(marketEstimate) : null,
    realizedProfit: realizedProfit != null ? round2(realizedProfit) : null,
    realizedMargin: realizedProfit != null && investedCost ? round2(realizedProfit / investedCost) : null,
    projectedProfit: projectedProfit != null ? round2(projectedProfit) : null,
    projectionBasis,
    projectedProfitAtSuggested: round2(profitAt(suggestedPrice)),
    // Actionable "how far from profit" signals:
    amountToBreakEven, // positive => you must raise price/lower cost by this much
    profitableAtCurrentPlan,
    profitAtListing: listingPrice != null ? round2(profitAt(listingPrice)) : null,
    marginAtListing: listingPrice != null && marginAt(listingPrice) != null ? round2(marginAt(listingPrice)) : null,
  };
}

/**
 * Portfolio-level rollup across many items (each already carries its financials).
 */
export function summarizePortfolio(itemsWithFinancials) {
  const s = {
    totalItems: itemsWithFinancials.length,
    inStock: 0,
    listed: 0,
    sold: 0,
    scrapped: 0,
    totalInvested: 0,
    investedInUnsold: 0,
    realizedProfit: 0,
    projectedProfit: 0,
    realizedRevenue: 0,
  };
  for (const { item, fin } of itemsWithFinancials) {
    s.totalInvested += fin.investedCost;
    if (item.status === 'in_stock') s.inStock++;
    else if (item.status === 'listed') s.listed++;
    else if (item.status === 'sold') s.sold++;
    else if (item.status === 'scrapped') s.scrapped++;

    if (item.status === 'sold') {
      if (fin.realizedProfit != null) s.realizedProfit += fin.realizedProfit;
      if (fin.realizedRevenue != null) s.realizedRevenue += fin.realizedRevenue;
    } else if (item.status !== 'scrapped') {
      s.investedInUnsold += fin.investedCost;
      if (fin.projectedProfit != null) s.projectedProfit += fin.projectedProfit;
    }
  }
  for (const k of ['totalInvested', 'investedInUnsold', 'realizedProfit', 'projectedProfit', 'realizedRevenue']) {
    s[k] = round2(s[k]);
  }
  return s;
}

export { round2 };
