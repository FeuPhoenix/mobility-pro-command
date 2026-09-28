/**
 * The demonstration dataset.
 *
 * Every company, provider, person and rate here is fictional. The email domains
 * are all `.test`, which is reserved by RFC 2606 and can never be delivered to,
 * so even a misconfiguration cannot reach a real mailbox.
 *
 * The replies are written the way freight providers actually write them:
 * inconsistent labels, a rate in prose, a surcharge with no amount, a revision
 * that arrives two days later. That is the point - the parsers have to earn
 * their result.
 */

export interface DemoContact {
  name: string;
  email: string;
  role: string;
  isPrimary: boolean;
}

export interface DemoProvider {
  name: string;
  kind: string;
  country: string;
  generalEmail: string;
  notes: string | null;
  /** Per-company relationship. */
  links: {
    company: 'MPD' | 'MPI';
    status: 'active' | 'contracted' | 'excluded' | 'prospect';
    restrictionReason?: string;
    accountRef?: string;
    lanes: [string, string][];
    contacts: DemoContact[];
  }[];
}

export const COMPANIES = [
  {
    code: 'MPD',
    name: 'Mobility Pro Distribution S.A.E.',
    country: 'Egypt',
    addressLines: ['Plot 27, Obour City Industrial Zone', 'Cairo, Egypt'],
  },
  {
    code: 'MPI',
    name: 'Mobility Pro Industrial FZE',
    country: 'United Arab Emirates',
    addressLines: ['Warehouse 14, Jebel Ali Free Zone South', 'Dubai, United Arab Emirates'],
  },
] as const;

/**
 * Demonstration passwords.
 *
 * Real accounts, real hashing, real sessions - the only thing special about
 * these is that the sign-in page lists them while the workspace holds demo
 * data, so anyone can try the different roles. They are useless outside a
 * demonstration dataset, and reseeding replaces them.
 */
export const DEMO_PASSWORD = 'FreightDemo2026';

export const USERS = [
  {
    key: 'manager',
    name: 'Hala Mansour',
    title: 'Logistics Operations Manager',
    email: 'hala.mansour@mobilitypro.test',
    role: 'logistics_manager' as const,
    companies: ['MPD', 'MPI'],
  },
  {
    key: 'coordinator',
    name: 'Karim Fahmy',
    title: 'Logistics Coordinator',
    email: 'karim.fahmy@mobilitypro.test',
    role: 'logistics_coordinator' as const,
    companies: ['MPD'],
  },
  {
    key: 'industrial',
    name: 'Reem Al Suwaidi',
    title: 'Supply Chain Lead, Industrial',
    email: 'reem.alsuwaidi@mobilitypro.test',
    role: 'logistics_manager' as const,
    // Deliberately only one company, so company isolation is demonstrable.
    companies: ['MPI'],
  },
] as const;

export const PROVIDERS: DemoProvider[] = [
  {
    name: 'Nile Star Logistics',
    kind: 'Freight forwarder',
    country: 'Egypt',
    generalEmail: 'ops@nilestar.test',
    notes: 'Strong on North China to Alexandria. Consolidates with two carriers.',
    links: [
      {
        company: 'MPD',
        status: 'active',
        accountRef: 'NS-MPD-2231',
        lanes: [
          ['CNSHA', 'EGALY'],
          ['CNNGB', 'EGALY'],
        ],
        contacts: [
          { name: 'Yasmine Farouk', email: 'yasmine.farouk@nilestar.test', role: 'Key account manager', isPrimary: true },
          { name: 'Nile Star Pricing Desk', email: 'pricing@nilestar.test', role: 'Pricing', isPrimary: false },
        ],
      },
    ],
  },
  {
    name: 'Levant Maritime Services',
    kind: 'NVOCC',
    country: 'Lebanon',
    generalEmail: 'quotes@levantmaritime.test',
    notes: 'Direct service, no transhipment. Usually the fastest on this lane.',
    links: [
      {
        company: 'MPD',
        status: 'active',
        accountRef: 'LMS-8841',
        lanes: [['CNSHA', 'EGALY']],
        contacts: [
          { name: 'Rami Haddad', email: 'rami.haddad@levantmaritime.test', role: 'Commercial manager', isPrimary: true },
        ],
      },
      {
        company: 'MPI',
        status: 'active',
        accountRef: 'LMS-9002',
        lanes: [['CNSHA', 'AEJEA']],
        contacts: [
          { name: 'Rami Haddad', email: 'rami.haddad@levantmaritime.test', role: 'Commercial manager', isPrimary: true },
        ],
      },
    ],
  },
  {
    name: 'Delta Freight Partners',
    kind: 'Freight forwarder',
    country: 'Egypt',
    generalEmail: 'info@deltafreight.test',
    notes: 'Competitive but their quotations often leave charges open.',
    links: [
      {
        company: 'MPD',
        status: 'active',
        accountRef: 'DFP-114',
        lanes: [['CNSHA', 'EGALY']],
        contacts: [
          { name: 'Mostafa Zaki', email: 'mostafa.zaki@deltafreight.test', role: 'Sales', isPrimary: true },
        ],
      },
    ],
  },
  {
    name: 'Suez Gateway Shipping',
    kind: 'Carrier agent',
    country: 'Egypt',
    generalEmail: 'bookings@suezgateway.test',
    notes: null,
    links: [
      {
        company: 'MPD',
        status: 'active',
        accountRef: 'SGS-7720',
        lanes: [['CNSHA', 'EGALY']],
        contacts: [
          { name: 'Amira Saleh', email: 'amira.saleh@suezgateway.test', role: 'Customer service', isPrimary: true },
        ],
      },
    ],
  },
  {
    name: 'Anchor Line Agencies',
    kind: 'NVOCC',
    country: 'United Arab Emirates',
    generalEmail: 'quotes@anchorline.test',
    notes: 'Quotes from a shared desk and rarely keeps the reference in the subject.',
    links: [
      {
        company: 'MPD',
        status: 'active',
        accountRef: 'AL-556',
        lanes: [
          ['CNSHA', 'EGALY'],
          ['AEJEA', 'EGALY'],
        ],
        contacts: [
          { name: 'Anchor Line Quotations', email: 'quotes@anchorline.test', role: 'Quotation desk', isPrimary: true },
        ],
      },
    ],
  },
  {
    name: 'Horizon Global Forwarding',
    kind: 'Freight forwarder',
    country: 'United Kingdom',
    generalEmail: 'egypt@horizonglobal.test',
    notes: 'Contracted annually for the European lanes.',
    links: [
      {
        company: 'MPD',
        status: 'contracted',
        restrictionReason:
          'Under a fixed annual agreement for European lanes until 31 March 2027. Approaching them for spot rates would cut across that contract.',
        accountRef: 'HGF-MPD-001',
        lanes: [['NLRTM', 'EGALY']],
        contacts: [
          { name: 'Peter Nowak', email: 'peter.nowak@horizonglobal.test', role: 'Account director', isPrimary: true },
        ],
      },
    ],
  },
  {
    name: 'Cape Meridian Shipping',
    kind: 'NVOCC',
    country: 'Singapore',
    generalEmail: 'sales@capemeridian.test',
    notes: 'Excluded after two missed sailings in 2025.',
    links: [
      {
        company: 'MPD',
        status: 'excluded',
        restrictionReason:
          'Excluded by the Logistics Operations Manager in February 2026 after two missed sailings and an unrecovered demurrage claim.',
        lanes: [['CNSHA', 'EGALY']],
        contacts: [
          { name: 'Wei Lim', email: 'wei.lim@capemeridian.test', role: 'Sales', isPrimary: true },
        ],
      },
    ],
  },
  {
    name: 'Pharos Container Line',
    kind: 'Carrier',
    country: 'Egypt',
    generalEmail: 'commercial@pharosline.test',
    notes: 'Introduced at the Alexandria trade day. Not yet onboarded.',
    links: [
      {
        company: 'MPD',
        status: 'prospect',
        lanes: [['CNSHA', 'EGALY']],
        contacts: [
          { name: 'Sara Nabil', email: 'sara.nabil@pharosline.test', role: 'Business development', isPrimary: true },
        ],
      },
    ],
  },
  {
    name: 'Gulf Transit Company',
    kind: 'Freight forwarder',
    country: 'United Arab Emirates',
    generalEmail: 'ops@gulftransit.test',
    notes: null,
    links: [
      {
        company: 'MPI',
        status: 'active',
        accountRef: 'GTC-3301',
        lanes: [['CNSHA', 'AEJEA']],
        contacts: [
          { name: 'Fatima Al Marri', email: 'fatima.almarri@gulftransit.test', role: 'Operations', isPrimary: true },
        ],
      },
    ],
  },
];

/* ------------------------------ Reply bodies -------------------------------- */

/**
 * A clean, fully specified offer. It is the cheapest on total, but it is also
 * the slowest by a wide margin and has the least free time. That is what makes
 * the recommendation worth reading: the cheapest offer does not win.
 */
export const REPLY_NILE_STAR = (reference: string) => `Dear Hala,

Thank you for RFQ ${reference}. We are pleased to quote as follows.

Shipping line: Oriental Star Express
Base ocean freight: USD 1,640.00 per 40HC
BAF: USD 185.00 per container
Origin THC: USD 120.00 per container
ISPS: USD 14.00 per container
Documentation fee: USD 45.00 per B/L
Total: USD 11,799.00
Transit time: 38 days
Free days at destination: 3 days
Valid until: 2026-11-30
Sailing: 2026-11-14
Payment terms: 30 days from bill of lading date
Includes: ocean freight, origin terminal handling, documentation
Excludes: destination terminal handling, customs clearance, inland delivery
Conditions: subject to equipment availability at time of booking

Best regards,
Yasmine Farouk
Nile Star Logistics`;

/**
 * More expensive but materially faster with far better free time. This is the
 * offer the weighted criteria should recommend over the cheapest one.
 */
export const REPLY_LEVANT = (reference: string) => `Hello Hala,

Our offer for ${reference} below. Direct service, no transhipment.

Carrier: Levant Direct Line
Ocean freight: USD 1,810.00 per 40HC
BAF: USD 160.00 per container
THC origin: USD 115.00 per container
ISPS: USD 12.00 per container
Doc fee: USD 40.00 per B/L
Total cost: USD 12,622.00
Transit: 24 days
Free time: 14 days at destination
Validity: 2026-12-05
ETD: 2026-11-12
Payment: 45 days from BL
Included: ocean freight, origin THC, documentation, ISPS
Excluded: destination THC, customs clearance, demurrage after free time
Remarks: rate held for two bookings, direct call at Alexandria

Kind regards,
Rami Haddad
Levant Maritime Services`;

/**
 * Looks like the cheapest offer on the page, but the destination terminal
 * handling charge has no amount. Treating that blank as zero is exactly the
 * mistake the comparison must refuse to make.
 */
export const REPLY_DELTA = (reference: string) => `Dear Sir/Madam,

Ref ${reference}, please find our best rate.

Line: Pan Arab Feeder
Base freight: USD 1,520.00 per 40HC
BAF: USD 175.00 per container
Origin THC: USD 110.00 per container
Destination THC: TBA - will confirm on booking
ISPS: USD 14.00 per container
Documentation: USD 50.00 per B/L
Transit time: 30 days
Free days: 7
Valid until: 2026-11-28
Sailing date: 2026-11-16
Payment terms: 50% advance, balance against documents
Excludes: destination charges, customs, delivery

Regards,
Mostafa Zaki
Delta Freight Partners`;

/** The first version. Superseded two days later by the revision below. */
export const REPLY_SUEZ_V1 = (reference: string) => `Hello,

Quotation for ${reference}:

Carrier: Red Sea Container Services
Ocean freight: USD 1,750.00 per 40HC
BAF: USD 190.00 per container
Origin THC: USD 125.00 per container
ISPS: USD 15.00 per container
Doc fee: USD 45.00 per B/L
Transit time: 29 days
Free days at destination: 7
Validity: 2026-11-22
Sailing: 2026-11-18
Payment terms: 30 days from BL

Amira Saleh
Suez Gateway Shipping`;

/** The revision. Cheaper and faster - version 1 must be kept, not overwritten. */
export const REPLY_SUEZ_V2 = (reference: string) => `Hello again,

Please disregard our earlier quotation for ${reference} and use the revised rate below. We have secured allocation on an earlier vessel.

Carrier: Red Sea Container Services
Ocean freight: USD 1,690.00 per 40HC
BAF: USD 190.00 per container
Origin THC: USD 125.00 per container
ISPS: USD 15.00 per container
Doc fee: USD 45.00 per B/L
Transit time: 27 days
Free days at destination: 10
Validity: 2026-12-01
Sailing: 2026-11-13
Payment terms: 30 days from BL

Amira Saleh
Suez Gateway Shipping`;

/**
 * No RFQ reference and the sender has two open RFQs, so it cannot be attached
 * automatically. A person has to say which one it belongs to.
 */
export const REPLY_ANCHOR_AMBIGUOUS = () => `Hi,

Thanks for the enquiry. Our rate is below.

Line: Anchor Feeder Service
Ocean freight: USD 1,780.00 per 40HC
BAF: USD 170.00 per container
Origin THC: USD 118.00 per container
ISPS: USD 13.00 per container
Doc fee: USD 45.00 per B/L
Transit time: 28 days
Free days: 8
Valid until: 2026-11-27
Sailing: 2026-11-15
Payment terms: 30 days

Anchor Line Quotations`;

/** A provider declining, so the chaser stops. */
export const REPLY_DECLINE = (reference: string) => `Dear Hala,

Regarding ${reference}, we are unable to quote on this lane for the requested dates - we have no space allocation out of Shanghai in that window.

Apologies, and please keep us on the list for December.

Fatima Al Marri
Gulf Transit Company`;

/**
 * The spreadsheet quotation, as a provider would lay it out: labels in one
 * column, values in the next, and no relation to anyone else's template.
 */
export const EXCEL_QUOTE_ROWS: [string, string | number][] = [
  ['Quotation', 'Pharos Container Line'],
  ['Shipping line', 'Pharos Express Service'],
  ['Origin', 'CNSHA'],
  ['Destination', 'EGALY'],
  ['Container', '40HC'],
  ['Currency', 'USD'],
  ['Base freight', 1705],
  ['BAF', 178],
  ['Origin THC', 118],
  ['ISPS', 13],
  ['Documentation', 45],
  ['Total', 11702],
  ['Transit time', 26],
  ['Free days', 9],
  ['Validity', '2026-12-03'],
  ['Sailing date', '2026-11-15'],
  ['Payment terms', '30 days from bill of lading'],
  ['Inclusions', 'Ocean freight, origin THC, documentation'],
  ['Exclusions', 'Destination THC, customs clearance'],
];
