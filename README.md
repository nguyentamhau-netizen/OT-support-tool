# OT Support Tool

Hệ thống quản lý và nhắc lịch trực OT Support cho dự án, tích hợp đồng bộ dữ liệu với Taiga và tự động gửi thông báo qua Google Chat.

## 🛠 Kiến trúc & Công nghệ

Hệ thống hoạt động dưới dạng một Node.js Server (`server.mjs`) phục vụ cả giao diện Frontend và các API Backend:
- **Cơ sở dữ liệu (Database)**: Lưu trữ dưới dạng các file CSV cục bộ đặt tại thư mục `db_cache/` (không còn sử dụng Google Sheets API trực tiếp từ app).
- **Tích hợp Taiga**: Đồng bộ thành viên (memberships), các ca trực (schedule slots) dạng issues, và cập nhật bình luận/trạng thái khi đăng ký/hủy trực.
- **Google Chat**: Gửi thông báo trực tiếp khi có yêu cầu cập nhật giờ trực, kết quả duyệt yêu cầu và gửi tin nhắn nhắc lịch trực cuối tuần vào mỗi chiều Thứ Sáu.

---

## ⚙️ Cấu hình Môi trường (.env)

Tạo file `.env` hoặc `.env.local` ở thư mục gốc của dự án với các cấu hình sau:

```env
# Port chạy ứng dụng (Mặc định: 4173)
PORT=4173

# --- CẤU HÌNH TAIGA ---
TAIGA_API_URL=https://projects.kyanon.digital/api/v1
TAIGA_PROJECT_SLUG=amaze-ot-log
TAIGA_USERNAME=tai_khoan_admin_taiga
TAIGA_PASSWORD=mat_khau_admin_taiga
# Hoặc thay bằng Token nếu có:
# TAIGA_ADMIN_TOKEN=your_admin_token

# --- CẤU HÌNH GOOGLE CHAT WEBHOOK ---
GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=...

# --- CẤU HÌNH AN TOÀN CHO CRON JOB ---
# Token bảo mật để kích hoạt API nhắc lịch từ bên ngoài
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

## 🔐 Đăng nhập Cục bộ (Local Login)

Để đăng nhập kiểm thử hoặc sử dụng tài khoản Admin cục bộ, sử dụng email:
```text
hau.nt@kyanon.digital
```
*Tài khoản này được định nghĩa mặc định có quyền ADMIN để quản lý các tính năng trong hệ thống.*

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
- `users.csv`: Thông tin danh sách thành viên và phân quyền (ADMIN/MEMBER).
- `schedule_slots.csv`: Danh sách các ngày/ca trực.
- `slot_capacities.csv`: Cấu hình số lượng người tối đa, số giờ trực yêu cầu cho từng ca.
- `registrations.csv`: Thông tin đăng ký trực của các thành viên.
- `update_requests.csv`: Các yêu cầu điều chỉnh giờ trực thực tế cần Admin phê duyệt.
- `chat_notifications.csv`: Nhật ký lịch sử gửi tin nhắn thông báo qua Google Chat.
- `settings.csv`: Cấu hình hệ thống (như domain giới hạn, webhook url,...).
