import { describe, it, expect, beforeEach } from 'vitest';
import { useFileIndexStore } from './fileIndexStore';

describe('fileIndexStore', () => {
  beforeEach(() => { useFileIndexStore.setState({ versionByProject: {} }); });
  it('bump 只加那一个项目的版本号', () => {
    useFileIndexStore.getState().bump('/a');
    useFileIndexStore.getState().bump('/a');
    useFileIndexStore.getState().bump('/b');
    expect(useFileIndexStore.getState().versionByProject).toEqual({ '/a': 2, '/b': 1 });
  });
});
