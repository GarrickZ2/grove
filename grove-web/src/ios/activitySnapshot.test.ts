import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({get:vi.fn(),projects:vi.fn(),project:vi.fn(),graph:vi.fn()}));
vi.mock('../api/client',()=>({apiClient:{get:mock.get}}));
vi.mock('../api/projects',()=>({listProjects:mock.projects,getProject:mock.project}));
vi.mock('../api/tasks',()=>({getTaskGraph:mock.graph}));
import { loadActivitySnapshot } from './activitySnapshot';
beforeEach(()=>{vi.resetAllMocks();});
it('uses canonical activity state on new servers',async()=>{
  mock.get.mockResolvedValue({chats:[{chat_id:'a',status:'connecting'}]});
  expect(await loadActivitySnapshot()).toEqual({chats:[{chat_id:'a',status:'connecting'}]});
  expect(mock.projects).not.toHaveBeenCalled();
});
it('old server fallback includes all projects, local tasks and parallel sessions',async()=>{
  mock.get.mockRejectedValue({status:404});
  mock.projects.mockResolvedValue({projects:[{id:'p'},{id:'q'}]});
  mock.project.mockImplementation(async(id:string)=>({id,tasks:[{id:'t',name:`Task ${id}`,enableChat:true}],local_task:{id:'_local',name:'Local',enableChat:true}}));
  mock.graph.mockResolvedValue({nodes:[{chat_id:'a',name:'First',status:'busy'},{chat_id:'b',name:'Second',status:'idle'}]});
  const result=await loadActivitySnapshot();
  expect(result.chats).toHaveLength(8);
  expect(mock.graph).toHaveBeenCalledWith('q','_local');
  expect(result.chats).toContainEqual({project_id:'q',task_id:'t',chat_id:'a',task_name:'Task q',chat_title:'First',status:'busy'});
});
it('does not turn authorization errors into misleading empty snapshots',async()=>{
  mock.get.mockRejectedValue({status:401});
  await expect(loadActivitySnapshot()).rejects.toEqual({status:401});
  expect(mock.projects).not.toHaveBeenCalled();
});
it('does not publish a partial total if a project fetch fails',async()=>{
  mock.get.mockRejectedValue({status:200});
  mock.projects.mockResolvedValue({projects:[{id:'p'}]});
  mock.project.mockRejectedValue(new Error('offline'));
  await expect(loadActivitySnapshot()).rejects.toThrow('offline');
});
