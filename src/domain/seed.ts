/**
 * The single fictional dataset behind the whole demo.
 *
 * ---------------------------------------------------------------------------
 * DEMO ASSUMPTIONS (all fictional; none of this describes a real client)
 * ---------------------------------------------------------------------------
 *  - Business: a tyre importer / distributor operating in Egypt, with
 *    distribution centres in Greater Cairo and Alexandria.
 *    The briefing workbook references size, ply and pattern, which is why a
 *    tyre catalogue was chosen. This is an assumption, not a verified
 *    description of the client's full business.
 *  - Currency: EGP throughout. Supplier documents are quoted in USD and carry
 *    a fixed demo FX rate (48.50 EGP/USD) recorded on the document itself.
 *  - "Today" is pinned to 17 Sep 2026 so the demo reads identically everywhere.
 *  - Brands, patterns, suppliers, customers, people and documents are invented.
 * ---------------------------------------------------------------------------
 */

import { DEMO_USD_EGP, round2 } from './money';
import { SEED_VERSION } from './version';
import { N8N_WORKFLOWS } from './automations';
import type {
  ActivityEvent,
  ApprovalRequest,
  Customer,
  CustomerPayment,
  DemoState,
  DemoUser,
  Discrepancy,
  DiscrepancyCase,
  HistoricalSale,
  InventoryOpportunity,
  PolicyDoc,
  PriceListVersion,
  PurchaseOrder,
  Reservation,
  SalesInvoice,
  SalesOrder,
  Shipment,
  Sku,
  StockLot,
  Supplier,
  SupplierDocument,
  Warehouse,
} from './types';

export { SEED_VERSION };
/** Pinned demo clock. Everything ages relative to this date. */
export const DEMO_TODAY = '2026-09-17';
/** The fictional importing entity. */
export const DEMO_COMPANY = 'Mobility Pro Distribution S.A.E.';

/* -------------------------------- People ---------------------------------- */

const users: DemoUser[] = [
  { id: 'U-RANA', name: 'Rana Fathy', role: 'supply_planning', title: 'Supply Planning Lead', initials: 'RF' },
  { id: 'U-OMAR', name: 'Omar Shalaby', role: 'procurement', title: 'Procurement Manager', initials: 'OS' },
  { id: 'U-NOUR', name: 'Nourhan Adel', role: 'finance', title: 'Credit Controller', initials: 'NA' },
  { id: 'U-SAMIR', name: 'Samir Ghali', role: 'finance', title: 'Finance Director', initials: 'SG' },
  { id: 'U-KAREEM', name: 'Kareem Fahmy', role: 'sales', title: 'Key Accounts Manager', initials: 'KF' },
  { id: 'U-DALIA', name: 'Dalia Mansour', role: 'management', title: 'Commercial Director', initials: 'DM' },
];

/* ------------------------------ Warehouses -------------------------------- */

const warehouses: Warehouse[] = [
  { id: 'WH-6OCT', name: '6th of October Distribution Centre', governorate: 'Giza', code: 'OCT' },
  { id: 'WH-OBOUR', name: 'Obour City Hub', governorate: 'Qalyubia', code: 'OBR' },
  { id: 'WH-ALEX', name: 'Alexandria Free Zone Depot', governorate: 'Alexandria', code: 'ALX' },
];

/* -------------------------------- Catalogue -------------------------------- */

const skus: Sku[] = [
  { id: 'TY-2657016-AT3', brand: 'Meridian', pattern: 'Terra AT-3', size: '265/70R16', ply: '10PR', segment: 'SUV/LT', unit: 'pcs', landedCost: 3540, listPrice: 4610 },
  { id: 'TY-2657016-HT2', brand: 'Meridian', pattern: 'Terra HT-2', size: '265/70R16', ply: '8PR', segment: 'SUV/LT', unit: 'pcs', landedCost: 3315, listPrice: 4345 },
  { id: 'TY-2656517-AT3', brand: 'Meridian', pattern: 'Terra AT-3', size: '265/65R17', ply: '10PR', segment: 'SUV/LT', unit: 'pcs', landedCost: 3815, listPrice: 5005 },
  { id: 'TY-2857516-MT4', brand: 'Sandstorm', pattern: 'Dune MT-4', size: '285/75R16', ply: '10PR', segment: 'SUV/LT', unit: 'pcs', landedCost: 4505, listPrice: 5930 },
  { id: 'TY-2657516-MT4', brand: 'Sandstorm', pattern: 'Dune MT-4', size: '265/75R16', ply: '10PR', segment: 'SUV/LT', unit: 'pcs', landedCost: 3935, listPrice: 5140 },
  { id: 'TY-2357517-AT3', brand: 'Meridian', pattern: 'Terra AT-3', size: '235/75R17', ply: '8PR', segment: 'SUV/LT', unit: 'pcs', landedCost: 3185, listPrice: 4160 },
  { id: 'TY-75016-LT6', brand: 'Sandstorm', pattern: 'Cargo LT-6', size: '750R16', ply: '14PR', segment: 'SUV/LT', unit: 'pcs', landedCost: 4910, listPrice: 6325 },
  { id: 'TY-2454018-UH5', brand: 'Voltec', pattern: 'Velos UH-5', size: '245/40R18', ply: 'SL', segment: 'PCR', unit: 'pcs', landedCost: 2800, listPrice: 3815 },
  { id: 'TY-2255017-UH5', brand: 'Voltec', pattern: 'Velos UH-5', size: '225/50R17', ply: 'SL', segment: 'PCR', unit: 'pcs', landedCost: 2455, listPrice: 3290 },
  { id: 'TY-1956515-EC1', brand: 'Voltec', pattern: 'Econa EC-1', size: '195/65R15', ply: 'SL', segment: 'PCR', unit: 'pcs', landedCost: 1560, listPrice: 2140 },
  { id: 'TY-2056516-EC1', brand: 'Voltec', pattern: 'Econa EC-1', size: '205/65R16', ply: 'SL', segment: 'PCR', unit: 'pcs', landedCost: 1730, listPrice: 2365 },
  { id: 'TY-11R225-RD9', brand: 'Meridian', pattern: 'Hauler RD-9', size: '11R22.5', ply: '16PR', segment: 'TBR', unit: 'pcs', landedCost: 13000, listPrice: 17030 },
  { id: 'TY-29580225-RD9', brand: 'Meridian', pattern: 'Hauler RD-9', size: '295/80R22.5', ply: '16PR', segment: 'TBR', unit: 'pcs', landedCost: 13795, listPrice: 18020 },
  { id: 'TY-31580225-SD7', brand: 'Meridian', pattern: 'Hauler SD-7', size: '315/80R22.5', ply: '20PR', segment: 'TBR', unit: 'pcs', landedCost: 15575, listPrice: 20185 },
  { id: 'TY-38565225-ST3', brand: 'Meridian', pattern: 'Trailer ST-3', size: '385/65R22.5', ply: '20PR', segment: 'TBR', unit: 'pcs', landedCost: 14785, listPrice: 19125 },
  { id: 'TY-1400R24-GR5', brand: 'Sandstorm', pattern: 'Grader GR-5', size: '14.00R24', ply: '20PR', segment: 'OTR', unit: 'pcs', landedCost: 32340, listPrice: 42110 },
  { id: 'TY-1200R20-RD9', brand: 'Meridian', pattern: 'Hauler RD-9', size: '12.00R20', ply: '18PR', segment: 'TBR', unit: 'pcs', landedCost: 14390, listPrice: 18730 },
];

/* --------------------------------- Stock ---------------------------------- */

const lots: StockLot[] = [
  // The aging opportunity at the centre of Journey B.
  { id: 'LOT-1001', skuId: 'TY-2657016-AT3', warehouseId: 'WH-OBOUR', qty: 812, reservedQty: 0, receivedOn: '2026-02-14', landedCost: 3540, sourceShipmentId: 'SHP-2026-0041' },
  { id: 'LOT-1002', skuId: 'TY-2657016-AT3', warehouseId: 'WH-6OCT', qty: 96, reservedQty: 24, receivedOn: '2026-07-30', landedCost: 3595 },
  { id: 'LOT-1003', skuId: 'TY-2657016-AT3', warehouseId: 'WH-ALEX', qty: 41, reservedQty: 0, receivedOn: '2026-08-20', landedCost: 3595 },

  { id: 'LOT-1010', skuId: 'TY-2657016-HT2', warehouseId: 'WH-OBOUR', qty: 268, reservedQty: 0, receivedOn: '2026-06-02', landedCost: 3315 },
  { id: 'LOT-1011', skuId: 'TY-2657016-HT2', warehouseId: 'WH-ALEX', qty: 144, reservedQty: 16, receivedOn: '2026-07-11', landedCost: 3315 },

  { id: 'LOT-1020', skuId: 'TY-2656517-AT3', warehouseId: 'WH-6OCT', qty: 412, reservedQty: 60, receivedOn: '2026-07-04', landedCost: 3815 },
  { id: 'LOT-1021', skuId: 'TY-2656517-AT3', warehouseId: 'WH-OBOUR', qty: 188, reservedQty: 0, receivedOn: '2026-05-19', landedCost: 3775 },

  { id: 'LOT-1030', skuId: 'TY-2857516-MT4', warehouseId: 'WH-OBOUR', qty: 96, reservedQty: 0, receivedOn: '2026-08-12', landedCost: 4505 },
  { id: 'LOT-1031', skuId: 'TY-2657516-MT4', warehouseId: 'WH-6OCT', qty: 154, reservedQty: 0, receivedOn: '2026-08-01', landedCost: 3935 },
  { id: 'LOT-1032', skuId: 'TY-2357517-AT3', warehouseId: 'WH-ALEX', qty: 320, reservedQty: 40, receivedOn: '2026-06-24', landedCost: 3185 },
  { id: 'LOT-1033', skuId: 'TY-75016-LT6', warehouseId: 'WH-OBOUR', qty: 210, reservedQty: 0, receivedOn: '2026-03-30', landedCost: 4910 },

  { id: 'LOT-1040', skuId: 'TY-2454018-UH5', warehouseId: 'WH-6OCT', qty: 288, reservedQty: 0, receivedOn: '2026-07-22', landedCost: 2800 },
  { id: 'LOT-1041', skuId: 'TY-2255017-UH5', warehouseId: 'WH-6OCT', qty: 464, reservedQty: 32, receivedOn: '2026-08-15', landedCost: 2455 },
  { id: 'LOT-1042', skuId: 'TY-1956515-EC1', warehouseId: 'WH-6OCT', qty: 1240, reservedQty: 120, receivedOn: '2026-08-28', landedCost: 1560 },
  { id: 'LOT-1043', skuId: 'TY-1956515-EC1', warehouseId: 'WH-ALEX', qty: 260, reservedQty: 0, receivedOn: '2026-08-28', landedCost: 1560 },

  // Warehouse imbalance: Alexandria nearly out while 6th of October is long.
  { id: 'LOT-1050', skuId: 'TY-2056516-EC1', warehouseId: 'WH-6OCT', qty: 640, reservedQty: 0, receivedOn: '2026-07-09', landedCost: 1730 },
  { id: 'LOT-1051', skuId: 'TY-2056516-EC1', warehouseId: 'WH-ALEX', qty: 12, reservedQty: 0, receivedOn: '2026-05-06', landedCost: 1705 },
  { id: 'LOT-1052', skuId: 'TY-2056516-EC1', warehouseId: 'WH-OBOUR', qty: 96, reservedQty: 0, receivedOn: '2026-07-09', landedCost: 1730 },

  { id: 'LOT-1060', skuId: 'TY-11R225-RD9', warehouseId: 'WH-6OCT', qty: 118, reservedQty: 24, receivedOn: '2026-06-18', landedCost: 13000 },
  { id: 'LOT-1061', skuId: 'TY-29580225-RD9', warehouseId: 'WH-6OCT', qty: 64, reservedQty: 0, receivedOn: '2026-06-18', landedCost: 13795 },
  { id: 'LOT-1062', skuId: 'TY-31580225-SD7', warehouseId: 'WH-ALEX', qty: 42, reservedQty: 12, receivedOn: '2026-05-02', landedCost: 15575 },
  { id: 'LOT-1063', skuId: 'TY-38565225-ST3', warehouseId: 'WH-6OCT', qty: 96, reservedQty: 0, receivedOn: '2026-08-06', landedCost: 14785 },
  { id: 'LOT-1064', skuId: 'TY-1200R20-RD9', warehouseId: 'WH-ALEX', qty: 58, reservedQty: 0, receivedOn: '2026-04-15', landedCost: 14390 },
  { id: 'LOT-1070', skuId: 'TY-1400R24-GR5', warehouseId: 'WH-ALEX', qty: 22, reservedQty: 4, receivedOn: '2026-07-27', landedCost: 32340 },
];

/* ------------------------------- Customers -------------------------------- */

const customers: Customer[] = [
  { id: 'C-NILEFLT', name: 'Nile Fleet Services', segment: 'Fleet', governorate: 'Cairo', contactName: 'Hassan Darwish', contactEmail: 'hassan.darwish@nilefleet.example', creditLimit: 18_500_000, paymentTermsDays: 90, onHold: false, since: '2019-04-02', owner: 'U-KAREEM' },
  { id: 'C-WASEELA', name: 'Al Waseela Auto Centres', segment: 'Retail chain', governorate: 'Giza', contactName: 'Mariam Sobhy', contactEmail: 'mariam@alwaseela.example', creditLimit: 11_900_000, paymentTermsDays: 60, onHold: false, since: '2017-11-20', owner: 'U-KAREEM' },
  { id: 'C-HORIZON', name: 'Horizon Logistics Egypt', segment: 'Fleet', governorate: 'Giza', contactName: 'Daniel Okafor', contactEmail: 'd.okafor@horizoneg.example', creditLimit: 14_500_000, paymentTermsDays: 60, onHold: false, since: '2020-02-17', owner: 'U-KAREEM' },
  { id: 'C-DELTAM', name: 'Delta Mobility Group', segment: 'Retail chain', governorate: 'Gharbia', contactName: 'Aisha Ramadan', contactEmail: 'aisha@deltamobility.example', creditLimit: 9_900_000, paymentTermsDays: 60, onHold: false, since: '2018-06-11', owner: 'U-KAREEM' },
  { id: 'C-RAMSES', name: 'Ramses Tyre Traders', segment: 'Wholesale', governorate: 'Cairo', contactName: 'Faisal Noor', contactEmail: 'faisal@ramsestyre.example', creditLimit: 7_900_000, paymentTermsDays: 45, onHold: false, since: '2016-09-05', owner: 'U-KAREEM' },
  { id: 'C-SUEZHT', name: 'Suez Heavy Transport', segment: 'Fleet', governorate: 'Suez', contactName: 'George Boutros', contactEmail: 'g.boutros@suezht.example', creditLimit: 11_900_000, paymentTermsDays: 60, onHold: false, since: '2021-01-25', owner: 'U-KAREEM' },
  { id: 'C-MINYA', name: 'Minya Motors', segment: 'Wholesale', governorate: 'Minya', contactName: 'Salem Abdel Aziz', contactEmail: 'salem@minyamotors.example', creditLimit: 4_600_000, paymentTermsDays: 30, onHold: false, since: '2022-03-14', owner: 'U-KAREEM' },
  { id: 'C-OASIS', name: 'Oasis Rent-a-Car Egypt', segment: 'Fleet', governorate: 'Cairo', contactName: 'Nadia Habib', contactEmail: 'nadia@oasisrent.example', creditLimit: 5_300_000, paymentTermsDays: 45, onHold: false, since: '2021-08-09', owner: 'U-KAREEM' },
  { id: 'C-CAIROGV', name: 'Cairo Governorate Fleet Authority', segment: 'Government', governorate: 'Cairo', contactName: 'Khaled El Masry', contactEmail: 'k.elmasry@cgfa.example', creditLimit: 26_400_000, paymentTermsDays: 90, onHold: false, since: '2015-05-30', owner: 'U-DALIA' },
  { id: 'C-ALEXSQ', name: 'Alexandria Tyre Souq', segment: 'Wholesale', governorate: 'Alexandria', contactName: 'Youssef Bakr', contactEmail: 'youssef@alextyre.example', creditLimit: 3_300_000, paymentTermsDays: 30, onHold: true, since: '2023-02-01', owner: 'U-KAREEM' },
  { id: 'C-SINAIEX', name: 'Sinai Export Trading', segment: 'Export', governorate: 'Port Said', contactName: 'Mona Fawzi', contactEmail: 'mona@sinaiexport.example', creditLimit: 6_600_000, paymentTermsDays: 30, onHold: false, since: '2020-10-12', owner: 'U-KAREEM' },
];

/* ------------------------------- Suppliers -------------------------------- */

const suppliers: Supplier[] = [
  { id: 'SUP-ORIENT', name: 'Orient Rubber Industries Co. Ltd', country: 'Thailand', contactName: 'Somchai Prasert', contactEmail: 'export@orientrubber.example', incoterm: 'CFR', paymentTerms: '30% TT advance, 70% against copy BL' },
  { id: 'SUP-SIAM', name: 'Siam Tread Partners', country: 'Thailand', contactName: 'Ratana Kul', contactEmail: 'sales@siamtread.example', incoterm: 'CFR', paymentTerms: '100% at sight LC' },
  { id: 'SUP-ANATOLIA', name: 'Anatolia Tyre A.S.', country: 'Turkiye', contactName: 'Emre Yilmaz', contactEmail: 'emre@anatoliatyre.example', incoterm: 'FOB', paymentTerms: '50% TT advance, 50% before shipment' },
];

/* ------------------------------ Receivables -------------------------------- */

const invoices: SalesInvoice[] = [
  // Nile Fleet Services - the credit exception in Journey B.
  { id: 'INV-2026-0412', customerId: 'C-NILEFLT', issuedOn: '2026-04-28', dueOn: '2026-07-27', total: 6_420_000, outstanding: 2_458_000 },
  { id: 'INV-2026-0533', customerId: 'C-NILEFLT', issuedOn: '2026-06-02', dueOn: '2026-08-31', total: 4_652_000, outstanding: 4_652_000 },
  { id: 'INV-2026-0611', customerId: 'C-NILEFLT', issuedOn: '2026-07-15', dueOn: '2026-10-13', total: 3_944_000, outstanding: 3_944_000 },
  { id: 'INV-2026-0702', customerId: 'C-NILEFLT', issuedOn: '2026-08-20', dueOn: '2026-11-18', total: 2_169_000, outstanding: 2_169_000 },

  { id: 'INV-2026-0388', customerId: 'C-WASEELA', issuedOn: '2026-06-14', dueOn: '2026-08-13', total: 2_804_000, outstanding: 0 },
  { id: 'INV-2026-0641', customerId: 'C-WASEELA', issuedOn: '2026-08-02', dueOn: '2026-10-01', total: 2_441_000, outstanding: 2_441_000 },
  { id: 'INV-2026-0688', customerId: 'C-WASEELA', issuedOn: '2026-08-29', dueOn: '2026-10-28', total: 1_271_000, outstanding: 1_271_000 },

  { id: 'INV-2026-0501', customerId: 'C-HORIZON', issuedOn: '2026-07-06', dueOn: '2026-09-04', total: 4_512_000, outstanding: 1_584_000 },
  { id: 'INV-2026-0665', customerId: 'C-HORIZON', issuedOn: '2026-08-18', dueOn: '2026-10-17', total: 3_016_000, outstanding: 3_016_000 },

  { id: 'INV-2026-0455', customerId: 'C-DELTAM', issuedOn: '2026-07-01', dueOn: '2026-08-30', total: 2_088_000, outstanding: 550_000 },
  { id: 'INV-2026-0679', customerId: 'C-DELTAM', issuedOn: '2026-08-25', dueOn: '2026-10-24', total: 1_750_000, outstanding: 1_750_000 },

  { id: 'INV-2026-0472', customerId: 'C-RAMSES', issuedOn: '2026-07-20', dueOn: '2026-09-03', total: 2_792_000, outstanding: 1_167_000 },

  { id: 'INV-2026-0694', customerId: 'C-SUEZHT', issuedOn: '2026-06-26', dueOn: '2026-08-25', total: 3_365_000, outstanding: 1_272_000 },
  { id: 'INV-2026-0701', customerId: 'C-SUEZHT', issuedOn: '2026-08-21', dueOn: '2026-10-20', total: 2_482_000, outstanding: 2_482_000 },

  { id: 'INV-2026-0521', customerId: 'C-MINYA', issuedOn: '2026-08-04', dueOn: '2026-09-03', total: 2_223_000, outstanding: 2_223_000 },
  { id: 'INV-2026-0710', customerId: 'C-MINYA', issuedOn: '2026-09-01', dueOn: '2026-10-01', total: 1_886_000, outstanding: 1_886_000 },

  { id: 'INV-2026-0560', customerId: 'C-OASIS', issuedOn: '2026-08-11', dueOn: '2026-09-25', total: 1_038_000, outstanding: 1_038_000 },
  { id: 'INV-2026-0598', customerId: 'C-CAIROGV', issuedOn: '2026-07-09', dueOn: '2026-10-07', total: 8_084_000, outstanding: 8_084_000 },
  { id: 'INV-2026-0620', customerId: 'C-ALEXSQ', issuedOn: '2026-05-19', dueOn: '2026-06-18', total: 1_278_000, outstanding: 1_278_000 },
  { id: 'INV-2026-0655', customerId: 'C-SINAIEX', issuedOn: '2026-08-14', dueOn: '2026-09-13', total: 1_482_000, outstanding: 1_482_000 },
];

const payments: CustomerPayment[] = [
  { id: 'PAY-2026-0301', customerId: 'C-NILEFLT', receivedOn: '2026-07-24', amount: 3_962_000, invoiceId: 'INV-2026-0412' },
  { id: 'PAY-2026-0344', customerId: 'C-WASEELA', receivedOn: '2026-08-10', amount: 2_804_000, invoiceId: 'INV-2026-0388' },
  { id: 'PAY-2026-0361', customerId: 'C-HORIZON', receivedOn: '2026-09-02', amount: 2_928_000, invoiceId: 'INV-2026-0501' },
  { id: 'PAY-2026-0370', customerId: 'C-DELTAM', receivedOn: '2026-08-28', amount: 1_538_000, invoiceId: 'INV-2026-0455' },
  { id: 'PAY-2026-0382', customerId: 'C-RAMSES', receivedOn: '2026-09-05', amount: 1_625_000, invoiceId: 'INV-2026-0472' },
  { id: 'PAY-2026-0390', customerId: 'C-SUEZHT', receivedOn: '2026-08-30', amount: 2_093_000, invoiceId: 'INV-2026-0694' },
];

/* ------------------------------ Purchase side ------------------------------ */

const purchaseOrders: PurchaseOrder[] = [
  {
    id: 'PO-2026-0418',
    supplierId: 'SUP-ORIENT',
    orderedOn: '2026-06-24',
    incoterm: 'CFR',
    paymentTerms: '30% TT advance, 70% against copy BL',
    currency: 'USD',
    fxRate: DEMO_USD_EGP,
    status: 'Shipped',
    lines: [
      { lineNo: 1, skuId: 'TY-11R225-RD9', size: '11R22.5', ply: '16PR', pattern: 'Hauler RD-9', qty: 640, unitPriceUsd: 268.0 },
      { lineNo: 2, skuId: 'TY-29580225-RD9', size: '295/80R22.5', ply: '16PR', pattern: 'Hauler RD-9', qty: 320, unitPriceUsd: 284.5 },
      { lineNo: 3, skuId: 'TY-31580225-SD7', size: '315/80R22.5', ply: '20PR', pattern: 'Hauler SD-7', qty: 180, unitPriceUsd: 321.0 },
    ],
  },
  {
    id: 'PO-2026-0431',
    supplierId: 'SUP-SIAM',
    orderedOn: '2026-07-02',
    incoterm: 'CFR',
    paymentTerms: '100% at sight LC',
    currency: 'USD',
    fxRate: DEMO_USD_EGP,
    status: 'Shipped',
    lines: [
      { lineNo: 1, skuId: 'TY-1956515-EC1', size: '195/65R15', ply: 'SL', pattern: 'Econa EC-1', qty: 1200, unitPriceUsd: 31.4 },
      { lineNo: 2, skuId: 'TY-2255017-UH5', size: '225/50R17', ply: 'SL', pattern: 'Velos UH-5', qty: 480, unitPriceUsd: 49.8 },
    ],
  },
  {
    id: 'PO-2026-0447',
    supplierId: 'SUP-ANATOLIA',
    orderedOn: '2026-08-11',
    incoterm: 'FOB',
    paymentTerms: '50% TT advance, 50% before shipment',
    currency: 'USD',
    fxRate: DEMO_USD_EGP,
    status: 'In production',
    lines: [
      { lineNo: 1, skuId: 'TY-2657016-HT2', size: '265/70R16', ply: '8PR', pattern: 'Terra HT-2', qty: 400, unitPriceUsd: 66.5 },
      { lineNo: 2, skuId: 'TY-2056516-EC1', size: '205/65R16', ply: 'SL', pattern: 'Econa EC-1', qty: 900, unitPriceUsd: 34.2 },
    ],
  },
];

const shipments: Shipment[] = [
  {
    id: 'SHP-2026-0088',
    purchaseOrderId: 'PO-2026-0418',
    supplierId: 'SUP-ORIENT',
    vessel: 'MV Nile Meridian / V.238E',
    blNumber: 'ORBKK2608841',
    etd: '2026-08-06',
    eta: '2026-09-14',
    portOfLoading: 'Laem Chabang, TH',
    portOfDischarge: 'Alexandria (El Dekheila), EG',
    destinationWarehouseId: 'WH-ALEX',
    containers: ['TGHU 4471820', 'MSKU 9931047', 'CAIU 7712394'],
    status: 'Arrived',
  },
  {
    id: 'SHP-2026-0093',
    purchaseOrderId: 'PO-2026-0431',
    supplierId: 'SUP-SIAM',
    vessel: 'MV Siam Horizon / V.112W',
    blNumber: 'STPBKK2609113',
    etd: '2026-08-14',
    eta: '2026-09-19',
    portOfLoading: 'Bangkok, TH',
    portOfDischarge: 'Port Said East, EG',
    destinationWarehouseId: 'WH-6OCT',
    containers: ['FCIU 2280913', 'TCLU 6650182'],
    status: 'In transit',
  },
  {
    id: 'SHP-2026-0041',
    purchaseOrderId: 'PO-2026-0418',
    supplierId: 'SUP-ORIENT',
    vessel: 'MV Andaman Star / V.201E',
    blNumber: 'ORBKK2512204',
    etd: '2026-01-02',
    eta: '2026-02-11',
    portOfLoading: 'Laem Chabang, TH',
    portOfDischarge: 'Alexandria (El Dekheila), EG',
    destinationWarehouseId: 'WH-OBOUR',
    containers: ['OOLU 1120388'],
    status: 'Received',
  },
];

/* ------------------------- Supplier documents ------------------------------ */

const piOrient: SupplierDocument = {
  id: 'DOC-PI-0418-R1',
  kind: 'Pro forma invoice',
  purchaseOrderId: 'PO-2026-0418',
  shipmentId: 'SHP-2026-0088',
  supplierId: 'SUP-ORIENT',
  reference: 'PI-ORI-88412',
  issuedOn: '2026-07-29',
  receivedOn: '2026-09-15',
  revision: 1,
  extractionMode: 'simulated',
  extraction: [
    { key: 'header.supplier', label: 'Supplier', group: 'Header', value: 'Orient Rubber Industries Co. Ltd', originalValue: 'Orient Rubber Industries Co. Ltd', state: 'Confirmed', page: 1, anchor: 'p1-h-supplier', numeric: false },
    { key: 'header.reference', label: 'Document reference', group: 'Header', value: 'PI-ORI-88412', originalValue: 'PI-ORI-88412', state: 'Confirmed', page: 1, anchor: 'p1-h-ref', numeric: false },
    { key: 'header.poRef', label: 'Buyer PO reference', group: 'Header', value: 'PO-2026-0418', originalValue: 'PO-2026-0418', state: 'Confirmed', page: 1, anchor: 'p1-h-po', numeric: false },
    { key: 'header.incoterm', label: 'Incoterm', group: 'Header', value: 'CFR Alexandria', originalValue: 'CFR Alexandria', state: 'Needs review', page: 1, anchor: 'p1-h-incoterm', numeric: false },
    { key: 'header.currency', label: 'Currency', group: 'Header', value: 'USD', originalValue: 'USD', state: 'Confirmed', page: 1, anchor: 'p1-h-ccy', numeric: false },
    { key: 'header.paymentTerms', label: 'Payment terms', group: 'Header', value: '30% TT advance, 70% at sight', originalValue: '30% TT advance, 70% at sight', state: 'Needs review', page: 1, anchor: 'p1-h-terms', numeric: false },

    { key: 'line.1.size', label: 'Size', group: 'Line 1', value: '11R22.5', originalValue: '11R22.5', state: 'Confirmed', page: 1, anchor: 'p1-l1', numeric: false },
    { key: 'line.1.ply', label: 'Ply rating', group: 'Line 1', value: '18PR', originalValue: '18PR', state: 'Needs review', page: 1, anchor: 'p1-l1', numeric: false },
    { key: 'line.1.pattern', label: 'Pattern', group: 'Line 1', value: 'Hauler RD-9', originalValue: 'Hauler RD-9', state: 'Confirmed', page: 1, anchor: 'p1-l1', numeric: false },
    { key: 'line.1.qty', label: 'Quantity', group: 'Line 1', value: '600', originalValue: '600', state: 'Needs review', page: 1, anchor: 'p1-l1', numeric: true },
    { key: 'line.1.unitPrice', label: 'Unit price (USD)', group: 'Line 1', value: '268.00', originalValue: '268.00', state: 'Confirmed', page: 1, anchor: 'p1-l1', numeric: true },

    { key: 'line.2.size', label: 'Size', group: 'Line 2', value: '295/80R22.5', originalValue: '295/80R22.5', state: 'Confirmed', page: 1, anchor: 'p1-l2', numeric: false },
    { key: 'line.2.ply', label: 'Ply rating', group: 'Line 2', value: '16PR', originalValue: '16PR', state: 'Confirmed', page: 1, anchor: 'p1-l2', numeric: false },
    { key: 'line.2.pattern', label: 'Pattern', group: 'Line 2', value: 'Hauler RD-9', originalValue: 'Hauler RD-9', state: 'Confirmed', page: 1, anchor: 'p1-l2', numeric: false },
    { key: 'line.2.qty', label: 'Quantity', group: 'Line 2', value: '320', originalValue: '320', state: 'Confirmed', page: 1, anchor: 'p1-l2', numeric: true },
    { key: 'line.2.unitPrice', label: 'Unit price (USD)', group: 'Line 2', value: '289.00', originalValue: '289.00', state: 'Needs review', page: 1, anchor: 'p1-l2', numeric: true },

    { key: 'line.3.size', label: 'Size', group: 'Line 3', value: '315/80R22.5', originalValue: '315/80R22.5', state: 'Confirmed', page: 1, anchor: 'p1-l3', numeric: false },
    { key: 'line.3.ply', label: 'Ply rating', group: 'Line 3', value: '20PR', originalValue: '20PR', state: 'Confirmed', page: 1, anchor: 'p1-l3', numeric: false },
    { key: 'line.3.pattern', label: 'Pattern', group: 'Line 3', value: 'Hauler SD-7 (HD)', originalValue: 'Hauler SD-7 (HD)', state: 'Needs review', page: 1, anchor: 'p1-l3', numeric: false },
    { key: 'line.3.qty', label: 'Quantity', group: 'Line 3', value: '180', originalValue: '180', state: 'Confirmed', page: 1, anchor: 'p1-l3', numeric: true },
    { key: 'line.3.unitPrice', label: 'Unit price (USD)', group: 'Line 3', value: '321.00', originalValue: '321.00', state: 'Confirmed', page: 1, anchor: 'p1-l3', numeric: true },
  ],
  pages: [
    {
      page: 1,
      title: 'PRO FORMA INVOICE - PI-ORI-88412',
      rows: [
        { anchor: 'p1-h-supplier', cells: ['Seller', 'Orient Rubber Industries Co. Ltd, 88 Rayong Industrial Estate, Thailand'], heading: true },
        { anchor: 'p1-h-buyer', cells: ['Buyer', 'Mobility Pro Distribution S.A.E., Obour City, Qalyubia, Egypt'] },
        { anchor: 'p1-h-ref', cells: ['Invoice No.', 'PI-ORI-88412     Date: 29 Jul 2026'] },
        { anchor: 'p1-h-po', cells: ['Your Order No.', 'PO-2026-0418 dated 24 Jun 2026'] },
        { anchor: 'p1-h-incoterm', cells: ['Delivery term', 'CFR Alexandria'] },
        { anchor: 'p1-h-ccy', cells: ['Currency', 'USD'] },
        { anchor: 'p1-h-terms', cells: ['Payment', '30% TT advance, 70% at sight'], emphasis: true },
        { anchor: 'p1-cols', cells: ['#  DESCRIPTION', 'QTY', 'UNIT USD', 'AMOUNT USD'], heading: true },
        { anchor: 'p1-l1', cells: ['1  TBR 11R22.5 18PR HAULER RD-9', '600', '268.00', '160,800.00'], emphasis: true },
        { anchor: 'p1-l2', cells: ['2  TBR 295/80R22.5 16PR HAULER RD-9', '320', '289.00', '92,480.00'], emphasis: true },
        { anchor: 'p1-l3', cells: ['3  TBR 315/80R22.5 20PR HAULER SD-7 (HD)', '180', '321.00', '57,780.00'] },
        { anchor: 'p1-total', cells: ['TOTAL CFR ALEXANDRIA', '1,100', '', '311,060.00'], heading: true },
      ],
      footer: [
        'Bank: Siam Commercial Bank PCL, Rayong Branch - A/C 442-1-88104-3',
        'Validity: 30 days from date of issue. Shipment approx. 5 weeks after advance receipt.',
      ],
    },
    {
      page: 2,
      title: 'PRO FORMA INVOICE - PI-ORI-88412 (page 2 of 2)',
      rows: [
        { anchor: 'p2-pack', cells: ['Packing', 'Loose, palletised where applicable. 3 x 40HC.'], heading: true },
        { anchor: 'p2-marks', cells: ['Shipping marks', 'MOBILITY PRO / ALEXANDRIA / PO-2026-0418'] },
        { anchor: 'p2-origin', cells: ['Country of origin', 'Thailand'] },
        { anchor: 'p2-notes', cells: ['Remarks', 'Line 1 upgraded specification supplied subject to buyer confirmation.'], emphasis: true },
        { anchor: 'p2-sign', cells: ['Authorised signature', 'S. Prasert - Export Manager'] },
      ],
    },
  ],
};

const plOrient: SupplierDocument = {
  id: 'DOC-PL-0418',
  kind: 'Packing list',
  purchaseOrderId: 'PO-2026-0418',
  shipmentId: 'SHP-2026-0088',
  supplierId: 'SUP-ORIENT',
  reference: 'PL-ORI-88412',
  issuedOn: '2026-08-04',
  receivedOn: '2026-09-15',
  revision: 1,
  extractionMode: 'simulated',
  extraction: [
    { key: 'header.reference', label: 'Document reference', group: 'Header', value: 'PL-ORI-88412', originalValue: 'PL-ORI-88412', state: 'Confirmed', page: 1, anchor: 'pl-h-ref', numeric: false },
    { key: 'header.bl', label: 'Bill of lading', group: 'Header', value: 'ORBKK2608841', originalValue: 'ORBKK2608841', state: 'Confirmed', page: 1, anchor: 'pl-h-bl', numeric: false },
    { key: 'line.1.qty', label: 'Quantity', group: 'Line 1', value: '640', originalValue: '640', state: 'Confirmed', page: 1, anchor: 'pl-l1', numeric: true },
    { key: 'line.2.qty', label: 'Quantity', group: 'Line 2', value: '320', originalValue: '320', state: 'Confirmed', page: 1, anchor: 'pl-l2', numeric: true },
    { key: 'line.3.qty', label: 'Quantity', group: 'Line 3', value: '180', originalValue: '180', state: 'Confirmed', page: 1, anchor: 'pl-l3', numeric: true },
  ],
  pages: [
    {
      page: 1,
      title: 'PACKING LIST - PL-ORI-88412',
      rows: [
        { anchor: 'pl-h-ref', cells: ['Packing list No.', 'PL-ORI-88412     Date: 04 Aug 2026'], heading: true },
        { anchor: 'pl-h-bl', cells: ['B/L No.', 'ORBKK2608841 - MV Nile Meridian V.238E'] },
        { anchor: 'pl-cols', cells: ['#  DESCRIPTION', 'PCS', 'CTNS/PLT', 'GROSS KG'], heading: true },
        { anchor: 'pl-l1', cells: ['1  11R22.5 HAULER RD-9', '640', '32 plt', '42,240'], emphasis: true },
        { anchor: 'pl-l2', cells: ['2  295/80R22.5 HAULER RD-9', '320', '16 plt', '22,400'] },
        { anchor: 'pl-l3', cells: ['3  315/80R22.5 HAULER SD-7', '180', '9 plt', '14,760'] },
        { anchor: 'pl-total', cells: ['TOTAL', '1,140', '57 plt', '79,400'], heading: true },
      ],
      footer: ['Containers: TGHU 4471820 / MSKU 9931047 / CAIU 7712394'],
    },
  ],
};

const piSiam: SupplierDocument = {
  id: 'DOC-PI-0431',
  kind: 'Pro forma invoice',
  purchaseOrderId: 'PO-2026-0431',
  shipmentId: 'SHP-2026-0093',
  supplierId: 'SUP-SIAM',
  reference: 'PI-STP-20714',
  issuedOn: '2026-07-08',
  receivedOn: '2026-09-10',
  revision: 1,
  extractionMode: 'simulated',
  extraction: [
    { key: 'header.supplier', label: 'Supplier', group: 'Header', value: 'Siam Tread Partners', originalValue: 'Siam Tread Partners', state: 'Confirmed', page: 1, anchor: 's-h-sup', numeric: false },
    { key: 'header.reference', label: 'Document reference', group: 'Header', value: 'PI-STP-20714', originalValue: 'PI-STP-20714', state: 'Confirmed', page: 1, anchor: 's-h-ref', numeric: false },
    { key: 'header.poRef', label: 'Buyer PO reference', group: 'Header', value: 'PO-2026-0431', originalValue: 'PO-2026-0431', state: 'Confirmed', page: 1, anchor: 's-h-po', numeric: false },
    { key: 'header.incoterm', label: 'Incoterm', group: 'Header', value: 'CFR Port Said', originalValue: 'CFR Port Said', state: 'Confirmed', page: 1, anchor: 's-h-inco', numeric: false },
    { key: 'header.currency', label: 'Currency', group: 'Header', value: 'USD', originalValue: 'USD', state: 'Confirmed', page: 1, anchor: 's-h-ccy', numeric: false },
    { key: 'header.paymentTerms', label: 'Payment terms', group: 'Header', value: '100% at sight LC', originalValue: '100% at sight LC', state: 'Confirmed', page: 1, anchor: 's-h-terms', numeric: false },
    { key: 'line.1.size', label: 'Size', group: 'Line 1', value: '195/65R15', originalValue: '195/65R15', state: 'Confirmed', page: 1, anchor: 's-l1', numeric: false },
    { key: 'line.1.ply', label: 'Ply rating', group: 'Line 1', value: 'SL', originalValue: 'SL', state: 'Confirmed', page: 1, anchor: 's-l1', numeric: false },
    { key: 'line.1.pattern', label: 'Pattern', group: 'Line 1', value: 'Econa EC-1', originalValue: 'Econa EC-1', state: 'Confirmed', page: 1, anchor: 's-l1', numeric: false },
    { key: 'line.1.qty', label: 'Quantity', group: 'Line 1', value: '1200', originalValue: '1200', state: 'Confirmed', page: 1, anchor: 's-l1', numeric: true },
    { key: 'line.1.unitPrice', label: 'Unit price (USD)', group: 'Line 1', value: '31.40', originalValue: '31.40', state: 'Confirmed', page: 1, anchor: 's-l1', numeric: true },
    { key: 'line.2.size', label: 'Size', group: 'Line 2', value: '225/50R17', originalValue: '225/50R17', state: 'Confirmed', page: 1, anchor: 's-l2', numeric: false },
    { key: 'line.2.ply', label: 'Ply rating', group: 'Line 2', value: 'SL', originalValue: 'SL', state: 'Confirmed', page: 1, anchor: 's-l2', numeric: false },
    { key: 'line.2.pattern', label: 'Pattern', group: 'Line 2', value: 'Velos UH-5', originalValue: 'Velos UH-5', state: 'Confirmed', page: 1, anchor: 's-l2', numeric: false },
    { key: 'line.2.qty', label: 'Quantity', group: 'Line 2', value: '480', originalValue: '480', state: 'Confirmed', page: 1, anchor: 's-l2', numeric: true },
    { key: 'line.2.unitPrice', label: 'Unit price (USD)', group: 'Line 2', value: '49.80', originalValue: '49.80', state: 'Confirmed', page: 1, anchor: 's-l2', numeric: true },
  ],
  pages: [
    {
      page: 1,
      title: 'PRO FORMA INVOICE - PI-STP-20714',
      rows: [
        { anchor: 's-h-sup', cells: ['Seller', 'Siam Tread Partners, 14 Bangna-Trad Rd, Bangkok, Thailand'], heading: true },
        { anchor: 's-h-ref', cells: ['Invoice No.', 'PI-STP-20714     Date: 08 Jul 2026'] },
        { anchor: 's-h-po', cells: ['Your Order No.', 'PO-2026-0431 dated 02 Jul 2026'] },
        { anchor: 's-h-inco', cells: ['Delivery term', 'CFR Port Said'] },
        { anchor: 's-h-ccy', cells: ['Currency', 'USD'] },
        { anchor: 's-h-terms', cells: ['Payment', '100% at sight LC'] },
        { anchor: 's-cols', cells: ['#  DESCRIPTION', 'QTY', 'UNIT USD', 'AMOUNT USD'], heading: true },
        { anchor: 's-l1', cells: ['1  PCR 195/65R15 ECONA EC-1', '1,200', '31.40', '37,680.00'] },
        { anchor: 's-l2', cells: ['2  PCR 225/50R17 VELOS UH-5', '480', '49.80', '23,904.00'] },
        { anchor: 's-total', cells: ['TOTAL CFR PORT SAID', '1,680', '', '61,584.00'], heading: true },
      ],
      footer: ['LC to be opened through Commercial International Bank (CIB). Shipment within 4 weeks of LC receipt.'],
    },
  ],
};

const documents: SupplierDocument[] = [piOrient, plOrient, piSiam];

/* ------------------------------ Price lists -------------------------------- */

function priceMap(factor: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of skus) out[s.id] = round2(s.listPrice * factor);
  return out;
}

const priceLists: PriceListVersion[] = [
  {
    id: 'PL-2026-Q2',
    name: 'Egypt Trade Price List 2026-Q2',
    effectiveFrom: '2026-04-01',
    supersededOn: '2026-08-01',
    active: false,
    prices: priceMap(0.955),
  },
  {
    id: 'PL-2026-Q3',
    name: 'Egypt Trade Price List 2026-Q3',
    effectiveFrom: '2026-08-01',
    active: true,
    prices: priceMap(1),
  },
];

/* ---------------------------- Historical sales ----------------------------- */

const historicalSales: HistoricalSale[] = [
  // Aging SKU - strong Mar-Jun, collapses from July. That is the story.
  { id: 'HS-001', customerId: 'C-NILEFLT', skuId: 'TY-2657016-AT3', soldOn: '2026-03-09', qty: 120, unitPrice: 4515 },
  { id: 'HS-002', customerId: 'C-WASEELA', skuId: 'TY-2657016-AT3', soldOn: '2026-03-22', qty: 60, unitPrice: 4610 },
  { id: 'HS-003', customerId: 'C-HORIZON', skuId: 'TY-2657016-AT3', soldOn: '2026-04-11', qty: 84, unitPrice: 4490 },
  { id: 'HS-004', customerId: 'C-NILEFLT', skuId: 'TY-2657016-AT3', soldOn: '2026-04-27', qty: 96, unitPrice: 4465 },
  { id: 'HS-005', customerId: 'C-DELTAM', skuId: 'TY-2657016-AT3', soldOn: '2026-05-15', qty: 48, unitPrice: 4555 },
  { id: 'HS-006', customerId: 'C-OASIS', skuId: 'TY-2657016-AT3', soldOn: '2026-05-29', qty: 36, unitPrice: 4540 },
  { id: 'HS-007', customerId: 'C-NILEFLT', skuId: 'TY-2657016-AT3', soldOn: '2026-06-12', qty: 140, unitPrice: 4425 },
  { id: 'HS-008', customerId: 'C-WASEELA', skuId: 'TY-2657016-AT3', soldOn: '2026-06-30', qty: 44, unitPrice: 4580 },
  { id: 'HS-009', customerId: 'C-HORIZON', skuId: 'TY-2657016-AT3', soldOn: '2026-07-18', qty: 52, unitPrice: 4475 },
  { id: 'HS-010', customerId: 'C-DELTAM', skuId: 'TY-2657016-AT3', soldOn: '2026-08-05', qty: 30, unitPrice: 4515 },
  { id: 'HS-011', customerId: 'C-RAMSES', skuId: 'TY-2657016-AT3', soldOn: '2026-08-26', qty: 24, unitPrice: 4435 },
  { id: 'HS-012', customerId: 'C-WASEELA', skuId: 'TY-2657016-AT3', soldOn: '2026-09-04', qty: 18, unitPrice: 4555 },

  // Adjacent / substitute SKUs, used by the "who else buys this size" evidence.
  { id: 'HS-020', customerId: 'C-NILEFLT', skuId: 'TY-2657016-HT2', soldOn: '2026-07-02', qty: 64, unitPrice: 4250 },
  { id: 'HS-021', customerId: 'C-HORIZON', skuId: 'TY-2657016-HT2', soldOn: '2026-08-14', qty: 40, unitPrice: 4290 },
  { id: 'HS-022', customerId: 'C-DELTAM', skuId: 'TY-2656517-AT3', soldOn: '2026-08-19', qty: 56, unitPrice: 4910 },
  { id: 'HS-023', customerId: 'C-WASEELA', skuId: 'TY-2656517-AT3', soldOn: '2026-09-01', qty: 72, unitPrice: 4950 },
  { id: 'HS-024', customerId: 'C-OASIS', skuId: 'TY-2255017-UH5', soldOn: '2026-08-22', qty: 96, unitPrice: 3220 },
  { id: 'HS-025', customerId: 'C-MINYA', skuId: 'TY-1956515-EC1', soldOn: '2026-08-30', qty: 240, unitPrice: 2085 },
  { id: 'HS-026', customerId: 'C-ALEXSQ', skuId: 'TY-1956515-EC1', soldOn: '2026-06-15', qty: 180, unitPrice: 2060 },
  { id: 'HS-027', customerId: 'C-SINAIEX', skuId: 'TY-2056516-EC1', soldOn: '2026-08-27', qty: 320, unitPrice: 2295 },
  { id: 'HS-028', customerId: 'C-CAIROGV', skuId: 'TY-31580225-SD7', soldOn: '2026-07-12', qty: 48, unitPrice: 19865 },
  { id: 'HS-029', customerId: 'C-SUEZHT', skuId: 'TY-11R225-RD9', soldOn: '2026-08-03', qty: 64, unitPrice: 16735 },
  { id: 'HS-030', customerId: 'C-SUEZHT', skuId: 'TY-29580225-RD9', soldOn: '2026-06-21', qty: 40, unitPrice: 17720 },
  { id: 'HS-031', customerId: 'C-HORIZON', skuId: 'TY-11R225-RD9', soldOn: '2026-07-29', qty: 36, unitPrice: 16830 },
  { id: 'HS-032', customerId: 'C-NILEFLT', skuId: 'TY-11R225-RD9', soldOn: '2026-05-08', qty: 52, unitPrice: 16900 },
  { id: 'HS-033', customerId: 'C-RAMSES', skuId: 'TY-2357517-AT3', soldOn: '2026-07-24', qty: 88, unitPrice: 4080 },
  { id: 'HS-034', customerId: 'C-DELTAM', skuId: 'TY-2454018-UH5', soldOn: '2026-09-02', qty: 64, unitPrice: 3750 },
  { id: 'HS-035', customerId: 'C-CAIROGV', skuId: 'TY-1400R24-GR5', soldOn: '2026-08-08', qty: 8, unitPrice: 41580 },
  { id: 'HS-036', customerId: 'C-NILEFLT', skuId: 'TY-2657516-MT4', soldOn: '2026-06-05', qty: 72, unitPrice: 5030 },
  { id: 'HS-037', customerId: 'C-OASIS', skuId: 'TY-2657016-AT3', soldOn: '2025-12-18', qty: 60, unitPrice: 4645 },
  { id: 'HS-038', customerId: 'C-NILEFLT', skuId: 'TY-2657016-AT3', soldOn: '2025-11-06', qty: 108, unitPrice: 4685 },
];

/* -------------------------- Existing sales orders -------------------------- */

const salesOrders: SalesOrder[] = [
  {
    id: 'SO-2026-0766',
    customerId: 'C-MINYA',
    createdOn: '2026-09-15',
    createdBy: 'U-KAREEM',
    status: 'Blocked - credit',
    priceListId: 'PL-2026-Q3',
    reservationIds: [],
    notes: 'Seeded example: customer is already at the credit limit before this order is added.',
    lines: [
      { skuId: 'TY-1956515-EC1', qty: 360, warehouseId: 'WH-6OCT', listPrice: 2140, discountPct: 3, unitPrice: round2(2140 * 0.97), unitCost: 1560 },
      { skuId: 'TY-2056516-EC1', qty: 180, warehouseId: 'WH-6OCT', listPrice: 2365, discountPct: 3, unitPrice: round2(2365 * 0.97), unitCost: 1730 },
    ],
  },
  {
    id: 'SO-2026-0771',
    customerId: 'C-RAMSES',
    createdOn: '2026-09-16',
    createdBy: 'U-KAREEM',
    status: 'Draft',
    priceListId: 'PL-2026-Q2',
    reservationIds: [],
    notes: 'Seeded example: priced from a superseded price list version.',
    lines: [
      { skuId: 'TY-2357517-AT3', qty: 120, warehouseId: 'WH-ALEX', listPrice: round2(4160 * 0.955), discountPct: 0, unitPrice: round2(4160 * 0.955), unitCost: 3185 },
      { skuId: 'TY-2656517-AT3', qty: 60, warehouseId: 'WH-6OCT', listPrice: round2(5005 * 0.955), discountPct: 0, unitPrice: round2(5005 * 0.955), unitCost: 3815 },
    ],
  },
  {
    id: 'SO-2026-0758',
    customerId: 'C-WASEELA',
    createdOn: '2026-09-11',
    createdBy: 'U-KAREEM',
    status: 'Approved - reserved',
    priceListId: 'PL-2026-Q3',
    reservationIds: ['RES-9001'],
    lines: [
      { skuId: 'TY-2657016-AT3', qty: 24, warehouseId: 'WH-6OCT', listPrice: 4610, discountPct: 0, unitPrice: 4610, unitCost: 3595 },
    ],
  },
];

const reservations: Reservation[] = [
  { id: 'RES-9001', salesOrderId: 'SO-2026-0758', skuId: 'TY-2657016-AT3', warehouseId: 'WH-6OCT', qty: 24, createdAt: '2026-09-11T08:20:00Z' },
];

/* -------------------------------- Policies --------------------------------- */

const policies: PolicyDoc[] = [
  {
    id: 'POL-CREDIT',
    title: 'Credit and release policy',
    category: 'Credit policy',
    version: 'v3.1',
    updatedOn: '2026-05-01',
    clauses: [
      { ref: 'CR-2.1', text: 'Credit exposure = open receivables (invoiced, unpaid) + value of approved but undelivered sales orders. Draft orders are not exposure.' },
      { ref: 'CR-3.0', text: 'An order is released automatically when: the customer is not on hold, exposure after the order is within the approved credit limit, and no invoice is more than 30 days past due.' },
      { ref: 'CR-4.2', text: 'Where any invoice is more than 30 days past due, automatic release is withheld. The Finance Director may approve release against one of: (a) an advance deposit of at least 30% of order value, (b) a partial release limited to the uncovered portion of the limit, or (c) a documented finance review with a dated collection commitment.' },
      { ref: 'CR-5.4', text: 'Approval lapses if any material input changes after approval was requested: order quantity, unit price, customer credit limit, or overdue balance.' },
    ],
  },
  {
    id: 'POL-APPROVAL',
    title: 'Commercial approval matrix',
    category: 'Approval matrix',
    version: 'v2.4',
    updatedOn: '2026-03-18',
    clauses: [
      { ref: 'AM-1.1', text: 'Discount up to 5% of list: Key Accounts Manager.' },
      { ref: 'AM-1.2', text: 'Discount above 5% and up to 10% of list: Commercial Director.' },
      { ref: 'AM-1.3', text: 'Discount above 10% of list: Commercial Director and Finance Director jointly.' },
      { ref: 'AM-2.1', text: 'Credit release outside policy: Finance Director.' },
      { ref: 'AM-3.1', text: 'Supplier document override (accepting a discrepancy without correction): Procurement Manager, with a written reason retained on the case.' },
    ],
  },
  {
    id: 'POL-PROC',
    title: 'Import document control SOP',
    category: 'Procurement SOP',
    version: 'v1.9',
    updatedOn: '2026-02-09',
    clauses: [
      { ref: 'PR-1.2', text: 'Every supplier pro forma invoice is checked against the purchase order for size, ply rating, pattern, quantity, unit price, incoterm and payment terms before any payment instruction is raised.' },
      { ref: 'PR-2.1', text: 'A mismatch in size, ply rating or pattern is blocking. The shipment cannot be marked ready for receiving until the mismatch is corrected or explicitly overridden.' },
      { ref: 'PR-2.2', text: 'A quantity variance above 2% of the ordered quantity is blocking.' },
      { ref: 'PR-2.3', text: 'A unit price variance above 0.5% of the ordered price is blocking.' },
      { ref: 'PR-2.4', text: 'A change in payment terms is blocking and must be confirmed by Finance before payment.' },
      { ref: 'PR-3.1', text: 'Resolving a document case does not mean the goods have arrived, been counted, or that payment is approved. Those are separate steps.' },
    ],
  },
  {
    id: 'POL-PRICE',
    title: 'Trade pricing policy',
    category: 'Pricing policy',
    version: 'v2.0',
    updatedOn: '2026-08-01',
    clauses: [
      { ref: 'PP-1.1', text: 'Quotations must use the price list version active on the quotation date. Using a superseded version requires re-pricing before order confirmation.' },
      { ref: 'PP-2.3', text: 'Stock held beyond 180 days is eligible for a managed discount programme, subject to the approval matrix.' },
      { ref: 'PP-3.1', text: 'No sale may be confirmed below weighted landed cost without Finance Director approval.' },
    ],
  },
];

/* ------------------------------ Opportunity -------------------------------- */

const opportunities: InventoryOpportunity[] = [
  {
    id: 'OPP-2026-014',
    skuId: 'TY-2657016-AT3',
    warehouseId: 'WH-OBOUR',
    reason:
      'Lot LOT-1001 has been on hand 215 days at the Obour City Hub. Shipped volume for this SKU has fallen from an average of 157 pcs/month across March-June to 56 pcs/month over the trailing three months.',
    ruleId: 'INV-AGE-180',
    detectedOn: '2026-09-16',
    ownerId: 'U-RANA',
    status: 'Open',
    assumption: {
      baselineUnitsPerMonth: 56,
      unitsPerDiscountPoint: 4.5,
      horizonMonths: 3,
      collectionDelayDays: 12,
    },
  },
];

/* -------------------------------- Activity --------------------------------- */

const activity: ActivityEvent[] = [
  {
    id: 'ACT-0001',
    at: '2026-09-15T05:41:00Z',
    actor: 'Document control rules',
    kind: 'system',
    summary: 'Pro forma invoice PI-ORI-88412 received and checked against PO-2026-0418',
    detail: '4 mismatches detected (3 blocking, 1 advisory) under SOP v1.9 clauses PR-2.1, PR-2.2, PR-2.3, PR-2.4.',
    refs: [
      { type: 'document', id: 'DOC-PI-0418-R1', label: 'PI-ORI-88412' },
      { type: 'purchaseOrder', id: 'PO-2026-0418', label: 'PO-2026-0418' },
    ],
  },
  {
    id: 'ACT-0002',
    at: '2026-09-15T05:41:10Z',
    actor: 'Document control rules',
    kind: 'system',
    summary: 'Receiving readiness for SHP-2026-0088 held',
    detail: 'Blocking document mismatches must be resolved or overridden before the shipment can be marked ready for receiving.',
    refs: [{ type: 'shipment', id: 'SHP-2026-0088', label: 'SHP-2026-0088' }],
  },
  {
    id: 'ACT-0003',
    at: '2026-09-16T04:10:00Z',
    actor: 'Inventory rules',
    kind: 'system',
    summary: 'Aging stock opportunity raised for 265/70R16 10PR Terra AT-3 at Obour',
    detail: 'Rule INV-AGE-180: lot age 215 days and trailing 3-month shipped volume down 64% versus the March-June average.',
    refs: [
      { type: 'opportunity', id: 'OPP-2026-014', label: 'OPP-2026-014' },
      { type: 'sku', id: 'TY-2657016-AT3', label: '265/70R16 10PR Terra AT-3' },
    ],
  },
  {
    id: 'ACT-0004',
    at: '2026-09-15T11:02:00Z',
    actor: 'Credit rules',
    kind: 'system',
    summary: 'SO-2026-0766 held - Minya Motors over credit limit',
    detail: 'Exposure after the order exceeds the approved limit under credit policy CR-3.0.',
    refs: [
      { type: 'salesOrder', id: 'SO-2026-0766', label: 'SO-2026-0766' },
      { type: 'customer', id: 'C-MINYA', label: 'Minya Motors' },
    ],
  },
  {
    id: 'ACT-0005',
    at: '2026-09-16T07:35:00Z',
    actor: 'Pricing rules',
    kind: 'system',
    summary: 'SO-2026-0771 priced from superseded price list 2026-Q2',
    detail: 'Pricing policy PP-1.1: quotations must use the version active on the quotation date (2026-Q3 since 01 Aug 2026).',
    refs: [{ type: 'salesOrder', id: 'SO-2026-0771', label: 'SO-2026-0771' }],
  },
  {
    id: 'ACT-0006',
    at: '2026-09-11T08:20:00Z',
    actor: 'Kareem Fahmy',
    kind: 'user',
    summary: 'SO-2026-0758 approved and 24 pcs reserved at 6th of October for Al Waseela Auto Centres',
    refs: [
      { type: 'salesOrder', id: 'SO-2026-0758', label: 'SO-2026-0758' },
      { type: 'customer', id: 'C-WASEELA', label: 'Al Waseela Auto Centres' },
    ],
  },
];

const approvals: ApprovalRequest[] = [];
const cases: DiscrepancyCase[] = [];
const discrepancies: Discrepancy[] = [];

/* --------------------------------- Build ---------------------------------- */

export function buildSeedState(sessionId: string): DemoState {
  return JSON.parse(
    JSON.stringify({
      meta: {
        sessionId,
        createdAt: new Date().toISOString(),
        today: DEMO_TODAY,
        seedVersion: SEED_VERSION,
        currentUserId: 'U-RANA',
        guidedStep: null,
        erpAdapter: 'ERPNext demo adapter',
      },
      users,
      skus,
      warehouses,
      lots,
      customers,
      suppliers,
      invoices,
      payments,
      purchaseOrders,
      documents,
      discrepancies,
      cases,
      shipments,
      priceLists,
      salesOrders,
      reservations,
      historicalSales,
      approvals,
      activity,
      opportunities,
      policies,
      automations: N8N_WORKFLOWS,
    }),
  ) as DemoState;
}
