import type { Role } from "./labels.ts";

/** Mirrors modules/access for what the interface offers; the server decides either way. */
export const isSuperuser = (user: { role: Role }): boolean => user.role === "superuser";

export const managesHousehold = (user: { role: Role }): boolean => user.role === "superuser" || user.role === "familyAdmin";
