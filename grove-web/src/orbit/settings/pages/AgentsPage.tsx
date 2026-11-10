import { useState } from "react";
import { Package, Server, UserCog } from "lucide-react";
import { AgentPicker, CustomAgentModal } from "../../../components/ui";
import { CustomAgentsModal } from "../../../components/Config/CustomAgentsModal";
import { MarketplaceModal } from "../../../components/Config/MarketplaceModal";
import { Block, Group, Lead, Row, Segmented, Toggle } from "../../ui";
import { useSendModeSetting, type SendMode } from "../../../components/Config/useSendModeSetting";
import { BrowserControlGroup } from "./BrowserControlGroup";
import type { SettingsPageProps } from "./types";

function countLabel(count: number) {
  return <span className="oui-count">{count > 0 ? count : "None"}</span>;
}

export function AgentsPage({ settings }: SettingsPageProps) {
  const { sendMode, setSendMode } = useSendModeSetting();
  const {
    acpAgent,
    setAcpAgent,
    chatAgentOptions,
    customAgents,
    saveCustomAgentServers,
    customAgentPersonas,
    customAgentPersonasLoading,
    updateCustomAgentPersonas,
    baseAgentsLoading,
    chatHistoryRecentTurns,
    setChatHistoryRecentTurns,
    chatHistoryRecentTurnsDraft,
    setChatHistoryRecentTurnsDraft,
    recentSessions,
    setRecentSessions,
    recentSessionsDraft,
    setRecentSessionsDraft,
    chatHistoryIncludeMedia,
    setChatHistoryIncludeMedia,
    chatHistoryIncludeToolDetails,
    setChatHistoryIncludeToolDetails,
    chatRenderWindowLimit,
    chatRenderWindowLimitDraft,
    setChatRenderWindowLimitDraft,
    chatRenderWindowTriggerDraft,
    setChatRenderWindowTriggerDraft,
    commitChatRenderWindowLimit,
    commitChatRenderWindowTrigger,
    setChatRenderWindowMode,
  } = settings;
  const [showMarketplace, setShowMarketplace] = useState(false);
  const [showCustomAgents, setShowCustomAgents] = useState(false);
  const [showCustomServers, setShowCustomServers] = useState(false);

  const commitRecentSessions = () => {
    const parsed = Math.floor(Number(recentSessionsDraft));
    const next = Number.isFinite(parsed) && recentSessionsDraft.trim() !== "" ? Math.max(0, Math.min(200, parsed)) : recentSessions;
    setRecentSessions(next);
    setRecentSessionsDraft(String(next));
  };

  const commitRecentTurns = () => {
    const next = Math.max(1, Math.min(10000, Math.floor(Number(chatHistoryRecentTurnsDraft) || chatHistoryRecentTurns)));
    setChatHistoryRecentTurns(next);
    setChatHistoryRecentTurnsDraft(String(next));
  };

  return (
    <>
      <Group title="Default agent" anchorId="default">
        <Row title="Coding agent">
          <div className="ost-picker">
            {baseAgentsLoading ? (
              <div className="ost-picker-loading" aria-label="Loading agents"><span className="oui-skel" /></div>
            ) : (
              <AgentPicker
                value={acpAgent}
                onChange={setAcpAgent}
                options={chatAgentOptions}
                allowCustom={false}
                placeholder="Select agent..."
                customAgents={customAgents}
                triggerSize="compact"
              />
            )}
          </div>
        </Row>
      </Group>

      <Group title="Manage" anchorId="manage">
        <Row
          leading={<Lead><Package /></Lead>}
          title="Agent Marketplace"
          onClick={() => setShowMarketplace(true)}
        />
        <Row
          leading={<Lead><UserCog /></Lead>}
          title={<>Custom Agents{countLabel(customAgentPersonas.length)}</>}
          description="Personas with preset model & system prompt"
          onClick={() => setShowCustomAgents(true)}
        />
        <Row
          leading={<Lead><Server /></Lead>}
          title={<>Custom Agent Servers{countLabel(customAgents.length)}</>}
          description="For private or self-hosted ACP deploys"
          onClick={() => setShowCustomServers(true)}
        />
      </Group>

      <BrowserControlGroup settings={settings} />

      <Group title="Sending" anchorId="sending">
        <Row title="While the agent is working">
          <Segmented<SendMode>
            ariaLabel="While the agent is working"
            value={sendMode}
            options={[
              { value: "queue", label: "Queue", title: "Your message waits until the turn ends" },
              { value: "interrupt", label: "Interrupt", title: "Your message stops the current turn" },
            ]}
            onChange={setSendMode}
          />
        </Row>
      </Group>

      <Group title="Chat history" anchorId="history">
        <Row title="Messages to load">
          <Segmented
            ariaLabel="Messages to load"
            value={chatHistoryRecentTurns > 0 ? "recent" : "all"}
            options={[
              { value: "all", label: "All" },
              { value: "recent", label: "Recent" },
            ]}
            onChange={(next) => {
              if (next === "all") {
                setChatHistoryRecentTurns(0);
                setChatHistoryRecentTurnsDraft("0");
              } else {
                setChatHistoryRecentTurns(50);
                setChatHistoryRecentTurnsDraft("50");
              }
            }}
          />
        </Row>
        {chatHistoryRecentTurns > 0 ? (
          <Row title="Recent turns">
            <input
              type="number"
              min={1}
              max={10000}
              className="oui-field"
              value={chatHistoryRecentTurnsDraft}
              onChange={(event) => setChatHistoryRecentTurnsDraft(event.target.value)}
              onBlur={commitRecentTurns}
              aria-label="Recent chat turns to load"
            />
          </Row>
        ) : null}
        <Row title="Sessions kept in memory" description="Recent sessions and Buddies that open instantly. 0 turns this off.">
          <input
            type="number"
            min={0}
            max={200}
            className="oui-field"
            value={recentSessionsDraft}
            onChange={(event) => setRecentSessionsDraft(event.target.value)}
            onBlur={commitRecentSessions}
            aria-label="Sessions kept in memory"
          />
        </Row>
        <Row
          title="Images & audio"
          description={chatHistoryIncludeMedia ? "Download historical media with messages." : "Show placeholders without downloading media."}
        >
          <Toggle checked={chatHistoryIncludeMedia} onChange={setChatHistoryIncludeMedia} label="Include historical images and audio" />
        </Row>
        <Row
          title="Tool call details"
          description={chatHistoryIncludeToolDetails ? "Include tool inputs and outputs." : "Keep tool names and status only."}
        >
          <Toggle checked={chatHistoryIncludeToolDetails} onChange={setChatHistoryIncludeToolDetails} label="Include tool call details" />
        </Row>
      </Group>

      <Group
        title="Render window"
        anchorId="render"
        footnote="Older messages are hidden after a turn completes. Full chat history remains saved."
      >
        <Row
          title="Messages in view"
          description={chatRenderWindowLimit > 0
            ? `Keep latest ${chatRenderWindowLimit.toLocaleString()} messages`
            : "Keep the full conversation in view"}
        >
          <Segmented
            ariaLabel="Messages in view"
            value={chatRenderWindowLimit > 0 ? "custom" : "unlimited"}
            options={[
              { value: "unlimited", label: "Unlimited" },
              { value: "custom", label: "Custom" },
            ]}
            onChange={setChatRenderWindowMode}
          />
        </Row>
        {chatRenderWindowLimit > 0 ? (
          <Block>
            <div className="ost-inline-form">
              <span>Prune at</span>
              <input
                type="number"
                min={1}
                step={100}
                className="oui-field"
                value={chatRenderWindowLimitDraft}
                onChange={(event) => setChatRenderWindowLimitDraft(event.target.value)}
                onBlur={() => commitChatRenderWindowLimit(chatRenderWindowLimitDraft)}
                aria-label="Chat render window view size limit"
              />
              <span>messages when view reaches</span>
              <input
                type="number"
                min={chatRenderWindowLimit + 1}
                step={100}
                className="oui-field"
                value={chatRenderWindowTriggerDraft}
                onChange={(event) => setChatRenderWindowTriggerDraft(event.target.value)}
                onBlur={() => commitChatRenderWindowTrigger(chatRenderWindowTriggerDraft)}
                aria-label="Chat render window prune trigger size"
              />
              <span>messages.</span>
            </div>
          </Block>
        ) : null}
      </Group>

      <CustomAgentModal
        isOpen={showCustomServers}
        onClose={() => setShowCustomServers(false)}
        agents={customAgents}
        onSave={saveCustomAgentServers}
      />
      <CustomAgentsModal
        isOpen={showCustomAgents}
        onClose={() => setShowCustomAgents(false)}
        agents={customAgentPersonas}
        baseAgentOptions={chatAgentOptions}
        customServers={customAgents}
        loading={customAgentPersonasLoading}
        onChanged={updateCustomAgentPersonas}
      />
      <MarketplaceModal open={showMarketplace} onClose={() => setShowMarketplace(false)} />
    </>
  );
}
