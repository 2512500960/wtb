import * as React from 'react';
import { Link } from 'react-router-dom';

import { FEATURES } from '../features/flags';
import ChatSettingsSection from './settings/ChatSettingsSection';

export default function SettingsPage() {
  return (
    <div className="PageRoot">
      <div className="PageTopBar">
        <Link className="BackLink" to="/">
          ← 返回
        </Link>
        <div className="PageTitle">软件设置</div>
      </div>

      <div className="PageBody">
        {FEATURES.chat ? (
          <ChatSettingsSection />
        ) : (
          <div className="StatusEmpty">暂无可设置项</div>
        )}
      </div>
    </div>
  );
}
