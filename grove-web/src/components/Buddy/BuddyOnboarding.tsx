import { BuddyAvatar } from "./BuddyAvatar";
import { BUDDY_TEMPLATES, type BuddyTemplate } from "./buddyTemplates";
export function BuddyOnboarding({ onCreate }: { onCreate: (template?: BuddyTemplate) => void }) {
  return <section className="buddy-onboarding orbit-new"><div className="buddy-welcome-avatars">{[40, 56, 40].map((size, i) => <BuddyAvatar key={i} id={`welcome-${i}`} avatar={JSON.stringify(BUDDY_TEMPLATES[i].avatar)} size={size} state={i === 1 ? "working" : "idle"} />)}</div>
    <h1 className="orbit-new__title">Start with a Buddy</h1><p>A Buddy is a teammate that stays on. It remembers how you work, runs routines, and hands bigger jobs to other agents.</p>
    <div className="buddy-templates">{BUDDY_TEMPLATES.map(template => <button type="button" key={template.name} className="buddy-template" onClick={() => onCreate(template)}><BuddyAvatar id={template.name} avatar={JSON.stringify(template.avatar)} size={44} /><span><strong>{template.name}</strong><span>{template.role}</span><small>{template.note}</small></span></button>)}</div>
    <button type="button" className="buddy-button is-primary" onClick={() => onCreate()}>Start from scratch</button><small>Buddies run on your installed agents. Nothing runs until you send the first message.</small>
  </section>;
}
