import { Component, AfterViewInit, OnDestroy } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { embedDashboard } from '@superset-ui/embedded-sdk';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements AfterViewInit, OnDestroy {
  
  private intervalId: any;
  private currentUser = 'admin';

  ngAfterViewInit() {
    const userSelect = document.getElementById('user-select') as HTMLSelectElement;
    const reloadBtn = document.getElementById('reload-btn') as HTMLButtonElement;
    const userNameSpan = document.getElementById('user-name');
    
    reloadBtn?.addEventListener('click', () => {
      const selectedUser = userSelect?.value || 'admin';
      this.currentUser = selectedUser;
      
      if (userNameSpan) {
        userNameSpan.textContent = selectedUser;
      }
      
      this.reloadDashboard();
    });
  
    setTimeout(() => {
      this.loadDashboard();
    }, 100);
  }

  ngOnDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  private reloadDashboard() {
    // コンテナをクリア
    const container = document.getElementById('superset-container');
    if (container) {
      container.innerHTML = '';
    }
    
    // intervalをクリア
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    
    // 再読み込み
    setTimeout(() => {
      this.loadDashboard();
    }, 100);
  }

  private async loadDashboard() {
    try {
      const container = document.getElementById('superset-container');
      
      if (!container) {
        console.error('Container not found!');
        return;
      }

      console.log(`Loading dashboard for user: ${this.currentUser}`);

      await embedDashboard({
        id: '26060ee1-386e-4695-bd27-86518236229f',
        supersetDomain: 'http://localhost:8088',
        mountPoint: container,
        fetchGuestToken: () => this.fetchGuestToken(this.currentUser),
        dashboardUiConfig: {
          hideTitle: false,
          hideTab: false,
          hideChartControls: false,
        },
      });

      this.forceIframeSize();
      
    } catch (error) {
      console.error('Dashboard load error:', error);
    }
  }

  private forceIframeSize() {
    const container = document.getElementById('superset-container');
    if (!container) return;

    const setSize = () => {
      const iframe = container.querySelector('iframe') as HTMLIFrameElement;
      if (iframe) {
        iframe.style.width = window.innerWidth + 'px';
        iframe.style.height = window.innerHeight + 'px';
        iframe.style.position = 'fixed';
        iframe.style.top = '0';
        iframe.style.left = '0';
        iframe.style.border = 'none';
      }
    };

    this.intervalId = setInterval(setSize, 100);
    window.addEventListener('resize', setSize);
    setSize();
  }

  private async fetchGuestToken(username: string): Promise<string> {
    console.log(`Fetching guest token for: ${username}`);
    
    const response = await fetch('http://localhost:3000/api/superset/guest-token', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-user-id': username,
      },
      body: JSON.stringify({ 
        dashboardId: '26060ee1-386e-4695-bd27-86518236229f',
        username: username,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch guest token: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('Guest token received');
    return data.token;
  }
}