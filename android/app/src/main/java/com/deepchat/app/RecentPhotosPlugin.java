package com.deepchat.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

@CapacitorPlugin(
    name = "RecentPhotos",
    permissions = {
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "images", strings = { Manifest.permission.READ_MEDIA_IMAGES }),
        @Permission(alias = "selectedImages", strings = { Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED })
    }
)
public class RecentPhotosPlugin extends Plugin {

    private static final int MAX_RECENT_PHOTOS = 30;
    private static final int MAX_DECODE_EDGE = 4096;
    private static final Uri IMAGE_COLLECTION = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
    private final ExecutorService thumbnailWorkers = Executors.newFixedThreadPool(2);

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private String access() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (granted(Manifest.permission.READ_MEDIA_IMAGES)) {
                return "full";
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)) {
                return "limited";
            }
            return getPermissionState("images") == PermissionState.DENIED ? "settings" : "prompt";
        }
        if (granted(Manifest.permission.READ_EXTERNAL_STORAGE)) {
            return "full";
        }
        return getPermissionState("storage") == PermissionState.DENIED ? "settings" : "prompt";
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            requestPermissionForAliases(new String[] { "images", "selectedImages" }, call, "accessResult");
        } else {
            requestPermissionForAlias(
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "images" : "storage",
                call,
                "accessResult"
            );
        }
    }

    @PermissionCallback
    private void accessResult(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent intent = new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getContext().getPackageName(), null)
            );
            getActivity().startActivity(intent);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Could not open app settings", error);
        }
    }

    @Override
    protected void handleOnResume() {
        notifyListeners("resume", new JSObject());
    }

    @Override
    protected void handleOnDestroy() {
        thumbnailWorkers.shutdownNow();
    }

    @PluginMethod
    public void listPhotos(PluginCall call) {
        String access = access();
        JSArray photos = new JSArray();
        if (access.equals("full") || access.equals("limited")) {
            String[] columns = {
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.MIME_TYPE,
                MediaStore.Images.Media.SIZE,
                MediaStore.Images.Media.DATE_MODIFIED
            };
            String sort = MediaStore.Images.Media.DATE_ADDED + " DESC, " + MediaStore.Images.Media._ID + " DESC";
            try (Cursor cursor = getContext().getContentResolver().query(IMAGE_COLLECTION, columns, null, null, sort)) {
                if (cursor != null) {
                    int idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID);
                    int nameColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME);
                    int typeColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE);
                    int sizeColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE);
                    int modifiedColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_MODIFIED);
                    while (photos.length() < MAX_RECENT_PHOTOS && cursor.moveToNext()) {
                        long id = cursor.getLong(idColumn);
                        String name = cursor.getString(nameColumn);
                        String type = cursor.getString(typeColumn);
                        if (name == null || type == null || !type.startsWith("image/")) {
                            continue;
                        }
                        JSObject photo = new JSObject();
                        photo.put("id", Long.toString(id));
                        photo.put("uri", ContentUris.withAppendedId(IMAGE_COLLECTION, id).toString());
                        photo.put("name", name);
                        photo.put("mimeType", type);
                        photo.put("size", cursor.getLong(sizeColumn));
                        photo.put("modifiedAt", cursor.getLong(modifiedColumn));
                        photos.put(photo);
                    }
                }
            } catch (RuntimeException error) {
                call.reject("Could not read recent photos", error);
                return;
            }
        }
        JSObject response = new JSObject();
        response.put("access", access);
        response.put("photos", photos);
        call.resolve(response);
    }

    @PluginMethod
    public void thumbnail(PluginCall call) {
        String id = call.getString("id", "");
        int size = Math.max(192, Math.min(480, call.getInt("size", 320)));
        try {
            thumbnailWorkers.execute(() -> writeThumbnail(call, id, size));
        } catch (RejectedExecutionException error) {
            call.reject("Could not schedule thumbnail", error);
        }
    }

    @RequiresApi(Build.VERSION_CODES.P)
    private Bitmap decodeSquareThumbnail(ContentResolver resolver, Uri uri, int size) throws IOException {
        return ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri), (decoder, info, source) -> {
            int width = info.getSize().getWidth();
            int height = info.getSize().getHeight();
            // 先保证短边足够清晰再裁剪，避免长截图被按整图缩小后再次放大。
            float scale = Math.min(1f, Math.min((float) size / Math.min(width, height),
                (float) MAX_DECODE_EDGE / Math.max(width, height)));
            int scaledWidth = Math.max(1, Math.round(width * scale));
            int scaledHeight = Math.max(1, Math.round(height * scale));
            int side = Math.min(scaledWidth, scaledHeight);
            int left = (scaledWidth - side) / 2;
            int top = (scaledHeight - side) / 2;
            decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
            decoder.setTargetSize(scaledWidth, scaledHeight);
            decoder.setCrop(new Rect(left, top, left + side, top + side));
        });
    }

    @SuppressWarnings("deprecation")
    private void writeThumbnail(PluginCall call, String id, int size) {
        try {
            long value = Long.parseLong(id);
            Uri uri = ContentUris.withAppendedId(IMAGE_COLLECTION, value);
            ContentResolver resolver = getContext().getContentResolver();
            Bitmap bitmap = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? decodeSquareThumbnail(resolver, uri, size)
                : MediaStore.Images.Thumbnails.getThumbnail(resolver, value, MediaStore.Images.Thumbnails.MINI_KIND, null);
            if (bitmap == null) {
                call.reject("Photo has no thumbnail");
                return;
            }
            try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 92, output)) {
                    call.reject("Could not encode thumbnail");
                    return;
                }
                JSObject thumbnail = new JSObject();
                thumbnail.put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
                call.resolve(thumbnail);
            } finally {
                bitmap.recycle();
            }
        } catch (IOException | RuntimeException error) {
            call.reject("Could not open thumbnail", error);
        }
    }
}
