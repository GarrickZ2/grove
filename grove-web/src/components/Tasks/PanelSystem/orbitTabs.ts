/** Orbit tab title: a default "Label #N" name drops its "#N" unless the
 *  workspace has more than one tab of that panel. Renamed tabs show as is. */
export function orbitTabTitle(name: string, sameKindCount: number): string {
  const match = /^(.*) #\d+$/.exec(name);
  return match && sameKindCount <= 1 ? match[1] : name;
}
