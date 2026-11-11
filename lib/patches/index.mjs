// ALL_PATCHES 组装层：顺序=apply 顺序，与原 lib/core.js:6336 完全一致（PATCHES→CODE→ENGINE→NEW_TOOL）。
// 勿调换顺序——回归测试锁定过 {id:76} 必须先于 {id:70}。
import { PATCHES } from './patch-registry.mjs';
import { CODE_PATCHES } from './code-patches.mjs';
import { ENGINE_PATCHES } from './engine-patches.mjs';
import { NEW_TOOL_PATCHES } from './new-tool-patches.mjs';

export const ALL_PATCHES = [...PATCHES, ...CODE_PATCHES, ...ENGINE_PATCHES, ...NEW_TOOL_PATCHES];
