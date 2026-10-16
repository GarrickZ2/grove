import { describe, expect, it } from 'vitest';
import { activityContent, reduceActivity, type ActivityState } from './activityState';
const chat = (status: string, id = 'a') => ({ type:'chat_status', project_id:'p', task_id:'t', chat_id:id, task_name:'Fix login', chat_title:`Session ${id}`, status });
const turn = (state: string, extra = {}) => ({ ...chat('busy'), type:'turn', event:{state,...extra} });
const summary = (s: ActivityState, now=100) => activityContent(s, 'http://127.0.0.1:1234',now);
describe('server-wide session facts', () => {
  it('counts two sessions of one task separately and shows both names', () => {
    const s = reduceActivity(new Map(), {type:'activity_snapshot', chats:[chat('busy'),chat('busy','b'),chat('idle','c')]},10);
    expect(summary(s)).toMatchObject({title:'2 sessions',running:2,sessionCount:2,summary:'2 running',sessions:[{name:'Fix login · Session a'},{name:'Fix login · Session b'}]});
  });
  it('connecting and streamed history cannot fabricate running', () => {
    let s = reduceActivity(new Map(), chat('connecting'),10);
    for(const state of ['message_chunk','tool_changed','ask_form_required']) s=reduceActivity(s,turn(state),20);
    expect(summary(s)).toMatchObject({status:'connecting',running:0,connecting:1});
    expect(summary(reduceActivity(s,chat('idle'),30))).toBeNull();
  });
  it('idle immediately ends running without claiming successful completion', () => {
    const s = reduceActivity(reduceActivity(new Map(),chat('busy'),10),chat('idle'),20);
    expect(summary(s)).toMatchObject({status:'finished',running:0,completed:0});
  });
  it('disconnect never leaves a session running', () => {
    expect(summary(reduceActivity(reduceActivity(new Map(),chat('busy'),10),chat('disconnected'),20))).toBeNull();
  });
  it('keeps other sessions running after completion on the current page', () => {
    let s = reduceActivity(new Map(),{type:'activity_snapshot',chats:[chat('busy'),{...chat('busy','b'),project_id:'other'}]},10);
    s=reduceActivity(s,turn('completed',{stop_reason:'end_turn'}),20);
    expect(summary(s)).toMatchObject({running:1,sessionCount:1,title:'Fix login · Session b'});
  });
  it('takes TaskChat completion and busy false as authoritative', () => {
    const s = reduceActivity(new Map(),chat('busy'),10);
    const complete = reduceActivity(s,{...chat('busy'),type:'chat_runtime',event:{type:'complete',stop_reason:'end_turn'}},20);
    expect(summary(reduceActivity(complete,chat('idle'),30))).toMatchObject({status:'completed',running:0});
    expect(summary(reduceActivity(s,{...chat('busy'),type:'chat_runtime',event:{type:'busy',value:false}},20))?.running).toBe(0);
  });
  it('distinguishes failed, stopped, completed and waiting', () => {
    const s = reduceActivity(new Map(),chat('busy'),10);
    expect(summary(reduceActivity(s,turn('completed',{stop_reason:'Cancelled'}),20))?.status).toBe('cancelled');
    expect(summary(reduceActivity(s,turn('failed'),20))?.status).toBe('failed');
    expect(summary(reduceActivity(s,chat('permission_required'),20))?.status).toBe('waiting');
  });
  it('fresh snapshots remove absent active sessions and preserve explicit outcomes briefly', () => {
    const s=reduceActivity(new Map(),chat('busy'),10);
    expect(summary(reduceActivity(s,{type:'activity_snapshot',chats:[]},20))).toBeNull();
    const done=reduceActivity(s,turn('completed'),20);
    expect(summary(reduceActivity(done,{type:'activity_snapshot',chats:[chat('idle')]},30))?.status).toBe('completed');
    expect(summary(done,30021)).toBeNull();
  });
  it('never emits a fabricated timer or a generic task name', () => {
    let s=reduceActivity(new Map(),{...chat('busy'),task_name:'',chat_title:''},10);
    expect(summary(s)).toBeNull();
    s=reduceActivity(s,{...chat('busy'),type:'activity_metadata'},20);
    const first=summary(s)!;
    expect(first.title).toBe('Fix login · Session a');
    expect(first).not.toHaveProperty('startedAt');
    expect(summary(s,100000)?.title).toBe(first.title);
  });
  it('links one session precisely, and multiple sessions to the server task list', () => {
    const s=reduceActivity(new Map(),chat('busy'),10);
    expect(new URL(summary(s)!.link).searchParams.get('chat')).toBe('a');
    expect(new URL(summary(reduceActivity(s,chat('busy','b'),20))!.link).searchParams.has('task')).toBe(false);
  });
});
