from PIL import Image

input_file = "parkEnvelope.PNG"
output_file = "/Users/kadenwhite/Desktop/RVPark/Cash_Envelope.pdf"

# Desired physical size
width_inches = 9
height_inches = 4.125
dpi = 300

# At 300 DPI, 9" x 4.125" = 2700 x 1238 pixels
width_px = round(width_inches * dpi)
height_px = round(height_inches * dpi)

# Open PNG
img = Image.open(input_file)

# Handle transparency by placing it on a white background
if img.mode in ("RGBA", "LA"):
    background = Image.new("RGB", img.size, "white")
    if img.mode == "RGBA":
        background.paste(img, mask=img.getchannel("A"))
    else:
        background.paste(img, mask=img.getchannel("A"))
    img = background
else:
    img = img.convert("RGB")

# Resize image to exactly 9" x 4 1/8"
img = img.resize(
    (width_px, height_px),
    Image.Resampling.LANCZOS
)

# Save as PDF at 300 DPI
img.save(
    output_file,
    "PDF",
    resolution=dpi
)

print("Done!")
print(f"Saved to: {output_file}")
print('PDF size: 9" x 4 1/8"')