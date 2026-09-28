import { deprecated, suppressDeprecationWarnings, resetDeprecationWarnings } from '../src/utils/deprecation-warnings';

describe('deprecation-warnings', () => {
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    resetDeprecationWarnings();
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('should log a warning when deprecated is called', () => {
    deprecated('testMethod', 'test message', '1.0.0');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Deprecation Warning] Method "testMethod" is deprecated and will be removed in version 1.0.0. test message'),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Stack trace:'),
    );
  });

  it('should only log the warning once per method per session', () => {
    deprecated('testMethod', 'test message', '1.0.0');
    deprecated('testMethod', 'test message', '1.0.0');
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
  });

  it('should not log a warning if suppressed', () => {
    suppressDeprecationWarnings(true);
    deprecated('testMethod', 'test message', '1.0.0');
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    suppressDeprecationWarnings(false);
  });

  it('should show the caller in the stack trace', () => {
    function caller() {
      deprecated('callerMethod', 'message', '2.0.0');
    }
    caller();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('callerMethod'),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('caller'),
    );
  });
});
