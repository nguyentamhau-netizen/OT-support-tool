# OT Support Tool

Hệ thống quản lý và nhắc lịch trực OT Support cho dự án Amaze, vận hành độc lập trên cơ sở dữ liệu nội bộ (Excel/CSV) và tự động gửi thông báo qua Google Chat.

## 🛠 Kiến trúc & Công nghệ

Hệ thống hoạt động dưới dạng một Node.js Server (`server.mjs`) phục vụ cả giao diện Frontend và các API Backend:
- **Cơ sở dữ liệu (Database)**: Lưu trữ dưới dạng các file CSV cục bộ đặt tại thư mục `db_cache/` (mở, xem và quản lý trực tiếp bằng Excel).
- **Hệ thống xác thực độc lập**: Mã hóa mật khẩu bảo mật bằng thuật toán `scrypt` có sẵn trong Node.js. Hỗ trợ tự đổi mật khẩu cho người dùng và Reset mật khẩu cho Admin.
- **Google Chat**: Gửi thông báo trực tiếp khi có đăng ký, hủy ca, yêu cầu cập nhật giờ trực, kết quả duyệt yêu cầu và gửi tin nhắn nhắc lịch trực cuối tuần vào mỗi chiều Thứ Sáu.
- **Xuất bảng tính**: Tích hợp xuất file bảng chấm công theo template Excel (`AMAZE _ Time log - Overtime - 2026.xlsx`) bằng thư viện `exceljs`.

---

## ⚙️ Cấu hình Môi trường (.env)

Tạo file `.env` hoặc `.env.local` ở thư mục gốc của dự án với các cấu hình sau:

```env
# Port chạy ứng dụng (Mặc định: 4173)
PORT=4173

# Khóa bí mật cho JWT session token
JWT_SECRET=supersecretjwtkeyforotsupporttool2026

# Mật khẩu khởi tạo mặc định cho thành viên (Mặc định: Amaze@2026)
DEFAULT_PASSWORD=Amaze@2026

# --- CẤU HÌNH GOOGLE CHAT WEBHOOK ---
GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=...

# --- CẤU HÌNH AN TOÀN CHO CRON JOB ---
CRON_TOKEN=một_chuỗi_token_ngẫu_nhiên_bảo_mật

# --- CẤU HÌNH MÚI GIỜ (Khi deploy lên Render/Cloud) ---
TZ=Asia/Ho_Chi_Minh
```

---

## 🚀 Chạy cục bộ (Run Locally)

1. Cài đặt các thư viện cần thiết:
   ```bash
   npm install
   ```
2. Chạy ứng dụng:
   ```bash
   # Sử dụng file cmd sẵn có (Windows)
   .\start-local.cmd

   # Hoặc chạy trực tiếp bằng Node.js
   node server.mjs
   ```
3. Truy cập vào ứng dụng tại trình duyệt:
   ```text
   http://localhost:4173
   ```

---

## 🔐 Đăng nhập & Quản lý Tài khoản (Authentication)

- **Tài khoản Admin mặc định**:
  - Email: `hau.nt@kyanon.digital`
  - Mật khẩu mặc định: `Amaze@2026`
- **Tài khoản thành viên khác**:
  - Sử dụng email `@kyanon.digital` tương ứng trong danh sách `db_cache/users.csv`.
  - Mật khẩu ban đầu: `Amaze@2026`
- **Đổi mật khẩu**:
  - Người dùng có thể vào tab **My Profile** để đổi mật khẩu cá nhân bất kỳ lúc nào.
- **Reset mật khẩu (Admin)**:
  - Admin có thể vào tab **Users** và nhấn nút **🔑 Reset Pass** để đặt lại mật khẩu của thành viên về mật khẩu mặc định.

---

## ⏰ Cấu hình Auto-Reminder (GitHub Actions Cron Job)

Ứng dụng cung cấp API `/api/chat/trigger-reminders` để quét lịch trực cuối tuần và gửi thông báo vào Google Chat. 

Để giải quyết vấn đề **Render Free Tier tự động ngủ**, GitHub Action của dự án được cấu hình để gửi request "đánh thức" server trước 1 phút, sau đó mới chính thức kích hoạt API.

### Thiết lập GitHub Secrets:
Trong repository của bạn trên GitHub, vào **Settings** -> **Secrets and variables** -> **Actions** và thêm:
- `CRON_TOKEN`: Trùng với biến `CRON_TOKEN` bạn cấu hình ở file `.env` trên Render.
- `RENDER_APP_URL`: Địa chỉ web service của bạn trên Render (ví dụ: `https://ot-support-tool.onrender.com`).

### File Cấu hình Workflow:
File này đã được tạo tại thư mục `.github/workflows/google-chat-reminder.yml`. Nó sẽ tự động kích hoạt vào **17:00 chiều Thứ Sáu hàng tuần** (giờ Việt Nam).

---

## 📂 Danh sách Bảng Dữ liệu (Thư mục `db_cache/`)

Các bảng dữ liệu được lưu dưới dạng file CSV phục vụ cho việc đọc ghi cục bộ bao gồm:
- `users.csv`: Danh sách thành viên, phân quyền (ADMIN/MEMBER), trạng thái và chuỗi mã hóa mật khẩu (`password_hash`).
- `schedule_slots.csv`: Danh sách các ngày/ca trực.
- `slot_capacities.csv`: Cấu hình số lượng người tối đa, số giờ trực yêu cầu cho từng ca.
- `registrations.csv`: Thông tin đăng ký trực của các thành viên.
- `update_requests.csv`: Các yêu cầu điều chỉnh giờ trực thực tế cần Admin phê duyệt.
- `chat_notifications.csv`: Nhật ký lịch sử gửi tin nhắn thông báo qua Google Chat.
- `settings.csv`: Cấu hình hệ thống (như domain giới hạn, webhook url,...).
