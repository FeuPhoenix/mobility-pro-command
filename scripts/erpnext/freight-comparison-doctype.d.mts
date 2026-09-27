export interface DocFieldDefinition {
  fieldname: string;
  fieldtype: string;
  label?: string;
  options?: string;
  unique?: number;
  [key: string]: unknown;
}

export interface DocTypeDefinition {
  doctype: 'DocType';
  name: string;
  module: string;
  custom: 1;
  fields: DocFieldDefinition[];
  [key: string]: unknown;
}

export const PARENT: string;
export const CHILD: string;
export const INTEGRATION_ROLE: string;
export function childDoctype(opts: { module: string }): DocTypeDefinition;
export function parentDoctype(opts: { module: string; supplierLink: boolean }): DocTypeDefinition;
