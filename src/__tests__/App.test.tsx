import '@testing-library/jest-dom';
import { act, render } from '@testing-library/react';
import App from '../renderer/App';

describe('App', () => {
  it('should render', async () => {
    (window as any).electron = {
      ipcRenderer: {
        invoke: jest.fn().mockResolvedValue([]),
        sendMessage: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
      },
    };

    await act(async () => {
      expect(render(<App />)).toBeTruthy();
    });
  });
});
