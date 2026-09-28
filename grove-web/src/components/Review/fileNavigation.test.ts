import { describe, expect, it } from 'vitest';
import { taskRelativeFilePath } from './fileNavigation';

describe('taskRelativeFilePath', () => {
  it('keeps task-relative paths unchanged', () => {
    expect(taskRelativeFilePath('chatbot_api/biz/tool.go', null)).toBe(
      'chatbot_api/biz/tool.go',
    );
  });

  it('converts an absolute Agent path to the Review tree path', () => {
    expect(
      taskRelativeFilePath(
        '/Users/example/work/ework_search/chatbot_api/biz/tool.go',
        '/Users/example/work/ework_search',
      ),
    ).toBe('chatbot_api/biz/tool.go');
  });

  it('waits for the task root before expanding an absolute path', () => {
    expect(taskRelativeFilePath('/Users/example/work/tool.go', null)).toBeNull();
  });

  it('does not expand absolute paths outside the task', () => {
    expect(
      taskRelativeFilePath(
        '/Users/example/other/tool.go',
        '/Users/example/work',
      ),
    ).toBeNull();
  });

  it('maps Windows absolute and file URL paths to the task tree', () => {
    expect(taskRelativeFilePath('C:\\Work\\Repo\\src\\main.rs', 'c:\\work\\repo'))
      .toBe('src/main.rs');
    expect(taskRelativeFilePath('file:///C:/Work/Repo/src/main.rs', 'C:\\Work\\Repo'))
      .toBe('src/main.rs');
    expect(taskRelativeFilePath('file://Server/Share/Repo/main.rs', '\\\\server\\share\\repo'))
      .toBe('main.rs');
    expect(taskRelativeFilePath('D:\\Other\\main.rs', 'C:\\Work\\Repo'))
      .toBeNull();
    expect(taskRelativeFilePath('C:\\Work\\Repo\\main.rs', null)).toBeNull();
  });
});
