# ZERA EDU — Server & Live Deployment Blueprint

This document outlines the server infrastructure parameters, git code synchronization workflows, and deployment guidelines to host the **ZERA EDU Backend** live on the AWS EC2 Windows instance.

---

## 🖥️ AWS EC2 Instance Profile

| Parameter            | Value                                                        |
|----------------------|--------------------------------------------------------------|
| **Instance ID**      | `i-0b9285d79c5f32f5e`                                        |
| **Instance Name**    | `attendancecorex`                                            |
| **Public IPv4**      | `65.2.70.49`                                                 |
| **Private IPv4**     | `172.31.7.113`                                               |
| **Instance Type**    | `t3.medium` (2 vCPUs, 4 GiB Memory)                          |
| **OS Platform**      | Windows Server 2025 English Full Base                        |
| **Key Pair**         | `attendancex`                                                |
| **Active App Port**  | `5000` (Suggested TCP range)                                 |

---

## 🔗 Version Control & Hosting Details

### Git Repositories
*   **Backend Repository**: `https://github.com/developerrhai/zera-edu-backend.git`
*   **Frontend Repository**: `https://github.com/developerrhai/zera-edu-frontend.git`

### Live Frontend Client
*   **Hosted on**: Vercel
*   **Production URL**: `https://zera-edu-frontend.vercel.app/`
*   **Vercel Backend Target**: `http://65.2.70.49:5000/api`

---

## 🛠️ Windows Server EC2 Prerequisites

Since the EC2 instance runs **Windows Server 2025**, the environment needs the following software pre-installed to orchestrate the Node.js service:
1.  **Node.js (LTS)**: Download and install the Windows Installer (`.msi`).
2.  **Git for Windows**: Download and run the setup to pull/push from GitHub.
3.  **MySQL Server**: Ensure MySQL is running on port `3306`. (A local instance can host multiple separate databases like `attendance_db` and `zera_edu`).
4.  **PM2 Process Manager**: Install globally via NPM to keep the backend running in the background:
    ```bash
    npm install -g pm2
    ```

---

## 🚀 Step-by-Step Deployment Instructions

### Phase 1: Push Local Code to GitHub
Ensure all code edits we made locally in `Vidyaaniketan2` are pushed to GitHub:
```bash
# Push Backend Code
cd backend
git init
git remote add origin https://github.com/developerrhai/zera-edu-backend.git
git branch -M main
git add .
git commit -m "feat: database refactoring, ULID, optimistic locking and admin controls"
git push -u origin main

# Push Frontend Code
cd ../frontend
git init
git remote add origin https://github.com/developerrhai/zera-edu-frontend.git
git branch -M main
git add .
git commit -m "feat: user search and admin UI for managing teacher rank"
git push -u origin main
```

### Phase 2: Remote Connect & Setup Backend on EC2
1.  Open **Remote Desktop Connection (RDP)** on your local computer.
2.  Connect to `65.2.70.49` as user `Administrator`. (Decrypt the administrator password using the AWS Console and your local `attendancex` private key file).
3.  Open Git Bash or Command Prompt on the server and create a deployment folder (e.g. `C:\apps\`).
4.  Clone the backend repository:
    ```bash
    cd C:\apps\
    git clone https://github.com/developerrhai/zera-edu-backend.git
    cd zera-edu-backend
    ```
5.  Install production packages:
    ```bash
    npm install --omit=dev
    ```
6.  Create a `.env` file in `C:\apps\zera-edu-backend\` with:
    ```env
    PORT=5000
    DB_HOST=127.0.0.1
    DB_PORT=3306
    DB_USER=root           # Or custom DB user
    DB_PASSWORD=your_pass  # MySQL root password on server
    DB_NAME=zera_edu       # New database name
    JWT_SECRET=your_jwt_secret
    JWT_REFRESH_SECRET=your_jwt_refresh_secret
    ```
7.  Log into your server's MySQL shell and create the database:
    ```sql
    CREATE DATABASE zera_edu;
    ```
8.  Start the backend process with PM2:
    ```bash
    pm2 start src/app.js --name zera-edu-backend
    pm2 save
    ```
9.  *(Optional)* Configure PM2 to start on system boot using `pm2-windows-service` or `pm2-windows-startup` on the Windows host.

### Phase 3: Open Network Ports (Firewalls & Security Groups)
To allow Vercel/clients to request `http://65.2.70.49:5000/api`, you must open port `5000`:
1.  **AWS Security Group**:
    *   Navigate to AWS EC2 Console -> Select `attendancecorex` -> Click **Security** -> Click active **Security Group**.
    *   Click **Edit inbound rules**.
    *   Add Rule: Type `Custom TCP`, Port Range `5000`, Source `0.0.0.0/0` (or Vercel IP blocks). Save rules.
2.  **Windows Defender Firewall**:
    *   Inside the Remote Desktop session, open **Windows Defender Firewall with Advanced Security**.
    *   Click **Inbound Rules** -> **New Rule**.
    *   Select **Port**, Protocol **TCP**, Specific local ports **5000**.
    *   Select **Allow the connection**, apply to Domain, Private, and Public profiles.
    *   Name the rule `Zera-Edu-Backend-Port-5000` and finish.

### Phase 4: Configure Vercel Frontend Env
1.  Open your Vercel Dashboard for `zera-edu-frontend`.
2.  In settings, update the environment variable `NEXT_PUBLIC_API_URL` or equivalent API endpoint configuration to `http://65.2.70.49:5000/api`.
3.  Redeploy the Vercel branch to update backend hooks.
