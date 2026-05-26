// Exports
import * as _ from "./runtime";
export { ClassWrapper, ManagedAllocation, ValueWrapper } from "./runtime";
export const Runtime = new _.Runtime();
export * from "./logger";
export * from "./extras";
// @ts-ignore Set by webpack at bundle time
export const version = VERSION;
