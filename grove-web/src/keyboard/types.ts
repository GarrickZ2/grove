export interface CommandDef {
  id: string;
  key: string;
  scope?: string;
  enabled?: () => boolean;
  handler: () => void;
  preventDefault?: boolean;
  passThroughTextInput?: boolean;
}

export interface ParsedKey {
  key: string;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}
