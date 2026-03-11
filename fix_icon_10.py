import sys
from PIL import Image

def fix_icon(path, original_path, target_scale=0.9):
    orig = Image.open(original_path).convert("RGBA")
    w, h = orig.size
    
    new_w = int(w * target_scale)
    new_h = int(h * target_scale)
    
    resized = orig.resize((new_w, new_h), Image.Resampling.LANCZOS)
    
    # Create entirely transparent canvas
    new_img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    
    offset_x = (w - new_w) // 2
    offset_y = (h - new_h) // 2
    
    new_img.paste(resized, (offset_x, offset_y), resized)
    new_img.save(path)
    print(f"Fixed and saved transparent padded {path} at {target_scale*100}% scale")

if __name__ == "__main__":
    for p in ["frontend/public/logo192.png", "frontend/public/logo512.png"]:
        try:
            fix_icon(p, p, 0.9) # Scale image to 90% (10% smaller)
        except Exception as e:
            print(f"Failed on {p}: {e}")
