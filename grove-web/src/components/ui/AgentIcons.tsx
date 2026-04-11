/* eslint-disable react-refresh/only-export-components */
interface AgentIconProps {
  size?: number;
  className?: string;
}

function svgIcon(src: string) {
  return function AgentSvgIcon({ size = 20, className }: AgentIconProps) {
    return <img src={src} width={size} height={size} className={className} alt="" />;
  };
}

export const Claude = { Color: svgIcon("/agent-icon/claude-color.svg") };
export const Gemini = { Color: svgIcon("/agent-icon/gemini-color.svg") };
export const Copilot = { Color: svgIcon("/agent-icon/githubcopilot.svg") };
export const Cursor = svgIcon("/agent-icon/cursor.svg");
export const Trae = { Color: svgIcon("/agent-icon/trae-color.svg") };
export const Qwen = { Color: svgIcon("/agent-icon/qwen-color.svg") };
export const Kimi = { Color: svgIcon("/agent-icon/kimi-color.svg") };
export const OpenAI = svgIcon("/agent-icon/openai.svg");
export const Windsurf = svgIcon("/agent-icon/windsurf.svg");
export const OpenCode = svgIcon("/agent-icon/opencode.svg");
export const Junie = { Color: svgIcon("/agent-icon/junie-color.svg") };
export const OpenClaw = { Color: svgIcon("/agent-icon/openclaw-color.svg") };
export const Hermes = svgIcon("/agent-icon/hermes.svg");
export const Kiro = svgIcon("/agent-icon/kiro.svg");
