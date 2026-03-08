import * as React from 'react';
import { Link } from 'react-router-dom';

import { FEATURES } from '../features/flags';
import ChatSettingsSection from './settings/ChatSettingsSection';
import YggdrasilPeersSettingsSection from './settings/YggdrasilPeersSettingsSection';

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
        <div className="StatusBlocks">
          <YggdrasilPeersSettingsSection />
          {FEATURES.chat ? <ChatSettingsSection /> : null}
        </div>
      </div>
    </div>
  );
}
