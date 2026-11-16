// Words for the demo CRM (@earshot/demo-crm). Pure and data-free, so client components can use it
// without shipping the dataset: pages count the records on the server and pass the numbers in.

/** How many of each record the demo CRM holds. */
export type DemoCrmCounts = { companies: number; contacts: number; deals: number };

/** "60 fictional companies, 150 people, and 40 deals, with names that sound alike on purpose…" */
export function describeDemoCrm({ companies, contacts, deals }: DemoCrmCounts): string {
  return `${companies} fictional companies, ${contacts} people, and ${deals} deals, with names that sound alike on purpose (Acme, Akme, Acmi)`;
}
