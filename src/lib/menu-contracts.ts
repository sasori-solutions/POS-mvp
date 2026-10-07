export interface MenuSchedule { weekdays: number[]; startMinute: number; endMinute: number }
export interface MenuConfiguration {
  id: string; publicId: string; revision: number; name: string; locationLabel: string; published: boolean;
  productIds: string[]; schedules: MenuSchedule[]; updatedAt: string;
}
export type MenuCommand = { command: 'menus' } | {
  command: 'save_menu'; operationId: string; menuId: string; expectedRevision: number | null;
  name: string; locationLabel: string; published: boolean; productIds: string[]; schedules: MenuSchedule[];
}
export interface MenuResponses { menus: { menus: MenuConfiguration[] }; save_menu: MenuConfiguration }
export type MenuErrorCode = 'MENU_CHANGED' | 'MENU_NOT_FOUND';
export interface PublicMenuProduct {
  id: string; name: string; category: string; priceCents: number; available: boolean; variablePrice: boolean; description: string;
  dietary: string; allergens: string; image: string | null;
  variations: { id: string; name: string; priceCents: number; soldOut: boolean }[];
  modifierGroups: { id: string; name: string; min: number; max: number; parentOptionId?: string;
    options: { id: string; name: string; priceCents: number; soldOut: boolean; maxQuantity: number }[] }[];
  comboComponents: { name: string; quantity: number; selectionLabel: string }[];
}
export interface PublicMenuDocument {
  publicId: string; businessName: string; name: string; locationLabel: string; timezone: string; asOf: string;
  availability: 'open' | 'outside_hours'; schedules: MenuSchedule[]; products: PublicMenuProduct[];
}
