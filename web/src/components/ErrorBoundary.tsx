import React from 'react';
import { Button, Result } from 'antd';

interface State {
  error: Error | null;
}

/** 兜底错误边界：单个页面渲染异常时不再整页白屏 */
export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ui] 页面渲染异常：', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <Result
          status="warning"
          title="页面出了点问题"
          subTitle={this.state.error.message || '未知错误，请刷新后重试'}
          extra={[
            <Button key="reload" type="primary" onClick={() => window.location.reload()}>
              刷新页面
            </Button>,
            <Button key="home" onClick={() => window.location.assign('/')}>
              回到工作台
            </Button>,
          ]}
        />
      );
    }
    return this.props.children;
  }
}
