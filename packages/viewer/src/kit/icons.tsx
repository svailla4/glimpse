// packages/viewer/src/kit/icons.tsx  (first version by WP0; owned by WP4; exported signatures are frozen)
// Curated Lucide registry: one import site, so the bundle holds only the icons listed here. Icons are functional,
// drawn in currentColor at stroke 1.5, 14 px inline and 16 px in controls. Add a name here before using it.
import {
  ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Copy, ExternalLink, File, Folder, GitCommitHorizontal, GripVertical, Info,
  Maximize2, Minus, Moon, Plus, RefreshCw, RotateCcw, Scan, Search, Sun, TriangleAlert, X, ZoomIn, ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import type {JSX} from 'react';

const ICONS = {
  'arrow-down': ArrowDown,
  'arrow-up': ArrowUp,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  close: X,
  commit: GitCommitHorizontal,
  copy: Copy,
  dark: Moon,
  expand: Maximize2,
  external: ExternalLink,
  file: File,
  fit: Scan,
  folder: Folder,
  grip: GripVertical,
  info: Info,
  light: Sun,
  minus: Minus,
  plus: Plus,
  refresh: RefreshCw,
  reset: RotateCcw,
  search: Search,
  warning: TriangleAlert,
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** Decorative by default (aria-hidden): give the enclosing control its own accessible name. */
export function Icon(p: {name: IconName; size?: 14 | 16}): JSX.Element {
  const Glyph = ICONS[p.name];
  return <Glyph className="gl-icon" size={p.size ?? 14} strokeWidth={1.5} aria-hidden="true" focusable="false" data-icon={p.name} />;
}
