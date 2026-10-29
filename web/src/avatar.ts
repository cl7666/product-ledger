/** 头像处理：把用户选择的图片在浏览器端裁剪成 128×128 的 JPEG data URL，避免大图进数据库 */
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];

export function fileToAvatar(file: File, size = 128): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ALLOWED.includes(file.type)) {
      reject(new Error('请选择 PNG / JPG / WebP 格式的图片'));
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      reject(new Error('图片不能超过 5MB'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败，请重试'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解析失败，请换一张图片'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('当前浏览器不支持图片处理'));
          return;
        }
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.86));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
