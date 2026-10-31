import { BuddyAvatar } from "./BuddyAvatar";
import { BUDDY_AVATAR_COLORS, BUDDY_AVATAR_RADIUS, BUDDY_AVATAR_SHAPES, type BuddyAvatarValue } from "./buddyAvatarConfig";
export function BuddyAvatarPicker({ value, onChange }: { value: BuddyAvatarValue; onChange: (value: BuddyAvatarValue) => void }) {
  return <fieldset className="buddy-avatar-picker"><legend>Avatar</legend><BuddyAvatar id="preview" avatar={JSON.stringify(value)} size={72} />
    <div className="buddy-avatar-options" aria-label="Avatar shape">{BUDDY_AVATAR_SHAPES.map(shape => <button type="button" key={shape} aria-label={`${shape} avatar`} aria-pressed={value.shape === shape} onClick={() => onChange({ ...value, shape })}><span style={{ width: 20, height: 20, borderRadius: BUDDY_AVATAR_RADIUS[shape], background: value.color }} /></button>)}</div>
    <div className="buddy-avatar-options" aria-label="Avatar color">{BUDDY_AVATAR_COLORS.map(color => <button type="button" key={color} aria-label={`${color} color`} aria-pressed={value.color === color} onClick={() => onChange({ ...value, color })}><span style={{ width: 16, height: 16, borderRadius: "50%", background: color }} /></button>)}</div>
  </fieldset>;
}
