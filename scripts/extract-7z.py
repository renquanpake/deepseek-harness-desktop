# 用 py7zr 解压 winCodeSign 7z（绕过 7za 的 symlink 权限问题）
# 解压到 electron-builder 缓存目录，供 app-builder 使用
import os
import shutil
import sys
import py7zr

CACHE = os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'electron-builder', 'Cache', 'winCodeSign')

def extract(sevenz_path):
    """解压 7z 到同名目录（无扩展名），返回目标目录"""
    target = os.path.splitext(sevenz_path)[0]
    if os.path.exists(target):
        shutil.rmtree(target)
    os.makedirs(target, exist_ok=True)
    try:
        with py7zr.SevenZipFile(sevenz_path, mode='r') as z:
            z.extractall(target)
    except Exception as e:
        print(f'[warn] extract partial: {e}')
    # 统计
    n = sum(len(fs) for _, _, fs in os.walk(target))
    print(f'extracted {sevenz_path} -> {target}: {n} files')
    return target

if __name__ == '__main__':
    sevenz = sys.argv[1]
    extract(sevenz)
