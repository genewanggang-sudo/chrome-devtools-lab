#!/usr/bin/env node

import assert from "node:assert/strict";
import { inflateSync, deflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_COLOR_TYPE_RGB = 2;
const PNG_COLOR_TYPE_RGBA = 6;
const PNG_BIT_DEPTH = 8;
const PNG_INTERLACE_NONE = 0;
const DEFAULT_MASK_OPTIONS = Object.freeze({
    darkLumaMax: 80,
    saturationMin: 0.35,
    saturationValueMin: 0.25,
    edgeContrastMin: 24,
});
const FALLBACK_DARK_LUMA_MAX = 100;
const DEFAULT_COMPARE_OPTIONS = Object.freeze({
    bboxTolerancePx: 2,
    centroidTolerancePx: 2,
    maskCountRelativeTolerance: 0.2,
});

/**
 * Decode the 8-bit RGB/RGBA PNGs returned by Chrome Page.captureScreenshot.
 * `source` may be the base64 `data` string, a { data } CDP result, or bytes.
 */
export function decodePng(source) {
    const bytes = CanvasAnchorInput.pngBytes(source);
    if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error("Expected a PNG signature.");
    }

    let offset = PNG_SIGNATURE.length;
    let header = null;
    const idatParts = [];
    let foundEnd = false;
    while (offset < bytes.length) {
        if (offset + 12 > bytes.length) throw new Error("PNG chunk is truncated.");
        const length = bytes.readUInt32BE(offset);
        const typeStart = offset + 4;
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        const crcEnd = dataEnd + 4;
        if (dataEnd < dataStart || crcEnd > bytes.length) throw new Error("PNG chunk length is invalid.");
        const type = bytes.toString("ascii", typeStart, dataStart);
        const payload = bytes.subarray(dataStart, dataEnd);
        const expectedCrc = bytes.readUInt32BE(dataEnd);
        const actualCrc = CanvasAnchorPng.crc32(bytes.subarray(typeStart, dataEnd));
        if (actualCrc !== expectedCrc) throw new Error(`PNG ${type} chunk CRC does not match.`);

        if (type === "IHDR") {
            if (header !== null || length !== 13) throw new Error("PNG IHDR chunk is invalid.");
            header = CanvasAnchorPng.header(payload);
        } else if (type === "IDAT") {
            if (header === null) throw new Error("PNG IDAT appears before IHDR.");
            idatParts.push(payload);
        } else if (type === "IEND") {
            if (length !== 0) throw new Error("PNG IEND chunk is invalid.");
            foundEnd = true;
            offset = crcEnd;
            break;
        }
        offset = crcEnd;
    }
    if (header === null || idatParts.length === 0 || !foundEnd) {
        throw new Error("PNG must contain IHDR, IDAT, and IEND chunks.");
    }
    if (offset !== bytes.length) throw new Error("PNG contains data after IEND.");

    const compressed = Buffer.concat(idatParts);
    let filtered;
    try {
        filtered = inflateSync(compressed);
    } catch (error) {
        throw new Error(`PNG IDAT cannot be inflated: ${error.message}`);
    }
    const stride = header.width * header.channels;
    const expectedLength = header.height * (stride + 1);
    if (filtered.length !== expectedLength) {
        throw new Error(`PNG scanline data has ${filtered.length} bytes; expected ${expectedLength}.`);
    }
    return {
        width: header.width,
        height: header.height,
        channels: header.channels,
        data: CanvasAnchorPng.unfilter(filtered, header.width, header.height, header.channels),
    };
}

/**
 * Derive a stable model/camera anchor from dark or saturated visible edges.
 * bbox and centroid coordinates are local to the requested canvas ROI.
 */
export function analyzeCanvasAnchor(source, options = {}) {
    const image = CanvasAnchorInput.image(source);
    const roi = CanvasAnchorInput.roi(options.roi, image.width, image.height);
    const maskOptions = CanvasAnchorInput.maskOptions(options);
    const mask = new Uint8Array(roi.width * roi.height);
    let maskCount = 0;
    let minX = roi.width;
    let minY = roi.height;
    let maxX = -1;
    let maxY = -1;
    let sumX = 0;
    let sumY = 0;

    for (let localY = 0; localY < roi.height; localY += 1) {
        for (let localX = 0; localX < roi.width; localX += 1) {
            const imageX = roi.x + localX;
            const imageY = roi.y + localY;
            if (!CanvasAnchorMask.isAnchorEdge(image, imageX, imageY, maskOptions)) continue;
            mask[localY * roi.width + localX] = 1;
            maskCount += 1;
            minX = Math.min(minX, localX);
            minY = Math.min(minY, localY);
            maxX = Math.max(maxX, localX);
            maxY = Math.max(maxY, localY);
            sumX += localX;
            sumY += localY;
        }
    }

    return {
        canvasSize: { width: image.width, height: image.height },
        roi,
        maskCount,
        bbox: maskCount === 0 ? null : {
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
        },
        centroid: maskCount === 0 ? null : {
            x: sumX / maskCount,
            y: sumY / maskCount,
        },
        mask,
    };
}

/**
 * Compare two screenshot anchors. This intentionally compares anchor geometry,
 * not whole-image pixels: UI text, antialiasing, and transient overlays may differ.
 */
export function compareCanvasAnchors(leftSource, rightSource, options = {}) {
    const analysisOptions = CanvasAnchorInput.analysisOptions(options);
    const left = analyzeCanvasAnchor(leftSource, { ...analysisOptions, roi: options.leftRoi ?? options.roi });
    const right = analyzeCanvasAnchor(rightSource, { ...analysisOptions, roi: options.rightRoi ?? options.roi });
    const compareOptions = CanvasAnchorInput.compareOptions(options);
    const reasons = [];
    const canvasSizeEqual = left.canvasSize.width === right.canvasSize.width
        && left.canvasSize.height === right.canvasSize.height;
    if (!canvasSizeEqual) {
        reasons.push(`canvas size differs: left ${left.canvasSize.width}x${left.canvasSize.height}, right ${right.canvasSize.width}x${right.canvasSize.height}.`);
    }
    if (left.maskCount === 0) reasons.push("left ROI has no dark/saturated edge pixels.");
    if (right.maskCount === 0) reasons.push("right ROI has no dark/saturated edge pixels.");

    const bboxDelta = CanvasAnchorComparison.bboxDelta(left.bbox, right.bbox);
    if (bboxDelta !== null && CanvasAnchorComparison.exceeds(bboxDelta, compareOptions.bboxTolerancePx)) {
        reasons.push(`bbox delta exceeds ${compareOptions.bboxTolerancePx}px: x=${bboxDelta.x}, y=${bboxDelta.y}, width=${bboxDelta.width}, height=${bboxDelta.height}.`);
    }
    const centroidDelta = CanvasAnchorComparison.centroidDelta(left.centroid, right.centroid);
    if (centroidDelta !== null && centroidDelta.distance > compareOptions.centroidTolerancePx) {
        reasons.push(`centroid distance ${centroidDelta.distance.toFixed(3)}px exceeds ${compareOptions.centroidTolerancePx}px (dx=${centroidDelta.x.toFixed(3)}, dy=${centroidDelta.y.toFixed(3)}).`);
    }
    const maskCountDelta = Math.abs(left.maskCount - right.maskCount);
    const maskCountRelativeDelta = Math.max(left.maskCount, right.maskCount) === 0
        ? 0
        : maskCountDelta / Math.max(left.maskCount, right.maskCount);
    if (maskCountRelativeDelta > compareOptions.maskCountRelativeTolerance) {
        reasons.push(`mask-count relative delta ${(maskCountRelativeDelta * 100).toFixed(2)}% exceeds ${(compareOptions.maskCountRelativeTolerance * 100).toFixed(2)}% (left=${left.maskCount}, right=${right.maskCount}).`);
    }
    const result = {
        valid: reasons.length === 0,
        reasons,
        left,
        right,
        comparison: {
            canvasSizeEqual,
            bboxDelta,
            centroidDelta,
            maskCountDelta,
            maskCountRelativeDelta,
            tolerances: compareOptions,
        },
    };
    if (result.valid || options.darkLumaMax !== undefined) return result;

    const fallback = compareCanvasAnchors(leftSource, rightSource, {
        ...options,
        darkLumaMax: FALLBACK_DARK_LUMA_MAX,
    });
    if (!fallback.valid) return result;
    return {
        ...fallback,
        maskSelection: {
            strategy: "dark-luma-fallback",
            selectedDarkLumaMax: FALLBACK_DARK_LUMA_MAX,
            primaryDarkLumaMax: DEFAULT_MASK_OPTIONS.darkLumaMax,
            primaryReasons: result.reasons,
        },
    };
}

export class CanvasAnchor {
    static decodePng(source) {
        return decodePng(source);
    }

    static analyze(source, options = {}) {
        return analyzeCanvasAnchor(source, options);
    }

    static compare(leftSource, rightSource, options = {}) {
        return compareCanvasAnchors(leftSource, rightSource, options);
    }
}

class CanvasAnchorInput {
    static pngBytes(source) {
        if (typeof source === "string") return Buffer.from(source.replace(/^data:image\/png;base64,/, ""), "base64");
        if (source && typeof source === "object" && typeof source.data === "string") return CanvasAnchorInput.pngBytes(source.data);
        if (Buffer.isBuffer(source)) return source;
        if (source instanceof Uint8Array) return Buffer.from(source);
        throw new TypeError("PNG source must be a base64 string, { data }, Buffer, or Uint8Array.");
    }

    static image(source) {
        if (source && typeof source === "object" && Number.isInteger(source.width)
            && Number.isInteger(source.height) && Number.isInteger(source.channels)
            && source.data instanceof Uint8Array) return source;
        return decodePng(source);
    }

    static roi(value, imageWidth, imageHeight) {
        const roi = value ?? { x: 0, y: 0, width: imageWidth, height: imageHeight };
        for (const key of ["x", "y", "width", "height"]) {
            if (!Number.isInteger(roi[key])) throw new TypeError(`ROI ${key} must be an integer.`);
        }
        if (roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0
            || roi.x + roi.width > imageWidth || roi.y + roi.height > imageHeight) {
            throw new RangeError(`ROI ${roi.x},${roi.y} ${roi.width}x${roi.height} is outside ${imageWidth}x${imageHeight}.`);
        }
        return { x: roi.x, y: roi.y, width: roi.width, height: roi.height };
    }

    static maskOptions(value) {
        const result = { ...DEFAULT_MASK_OPTIONS };
        for (const key of Object.keys(DEFAULT_MASK_OPTIONS)) {
            if (value[key] !== undefined) result[key] = CanvasAnchorInput.nonNegative(value[key], key);
        }
        if (result.saturationMin > 1 || result.saturationValueMin > 1) throw new RangeError("Saturation thresholds must be from 0 through 1.");
        return result;
    }

    static compareOptions(value) {
        const result = { ...DEFAULT_COMPARE_OPTIONS };
        for (const key of Object.keys(DEFAULT_COMPARE_OPTIONS)) {
            if (value[key] !== undefined) result[key] = CanvasAnchorInput.nonNegative(value[key], key);
        }
        return result;
    }

    static analysisOptions(value) {
        const result = {};
        for (const key of Object.keys(DEFAULT_MASK_OPTIONS)) {
            if (value[key] !== undefined) result[key] = value[key];
        }
        return result;
    }

    static nonNegative(value, name) {
        if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number.`);
        return value;
    }
}

class CanvasAnchorPng {
    static header(payload) {
        const width = payload.readUInt32BE(0);
        const height = payload.readUInt32BE(4);
        const bitDepth = payload[8];
        const colorType = payload[9];
        if (width === 0 || height === 0) throw new Error("PNG dimensions must be positive.");
        if (bitDepth !== PNG_BIT_DEPTH || ![PNG_COLOR_TYPE_RGB, PNG_COLOR_TYPE_RGBA].includes(colorType)) {
            throw new Error("Only non-indexed 8-bit RGB and RGBA PNGs are supported.");
        }
        if (payload[10] !== 0 || payload[11] !== 0 || payload[12] !== PNG_INTERLACE_NONE) {
            throw new Error("Only standard non-interlaced PNG compression and filtering are supported.");
        }
        return { width, height, channels: colorType === PNG_COLOR_TYPE_RGB ? 3 : 4 };
    }

    static unfilter(filtered, width, height, channels) {
        const stride = width * channels;
        const result = Buffer.allocUnsafe(stride * height);
        let inputOffset = 0;
        for (let y = 0; y < height; y += 1) {
            const filter = filtered[inputOffset];
            inputOffset += 1;
            const rowStart = y * stride;
            for (let x = 0; x < stride; x += 1) {
                const raw = filtered[inputOffset];
                inputOffset += 1;
                const left = x >= channels ? result[rowStart + x - channels] : 0;
                const up = y > 0 ? result[rowStart - stride + x] : 0;
                const upLeft = y > 0 && x >= channels ? result[rowStart - stride + x - channels] : 0;
                if (filter === 0) result[rowStart + x] = raw;
                else if (filter === 1) result[rowStart + x] = (raw + left) & 255;
                else if (filter === 2) result[rowStart + x] = (raw + up) & 255;
                else if (filter === 3) result[rowStart + x] = (raw + Math.floor((left + up) / 2)) & 255;
                else if (filter === 4) result[rowStart + x] = (raw + CanvasAnchorPng.paeth(left, up, upLeft)) & 255;
                else throw new Error(`PNG uses unsupported filter ${filter}.`);
            }
        }
        return result;
    }

    static paeth(left, up, upLeft) {
        const prediction = left + up - upLeft;
        const leftDistance = Math.abs(prediction - left);
        const upDistance = Math.abs(prediction - up);
        const upLeftDistance = Math.abs(prediction - upLeft);
        if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
        if (upDistance <= upLeftDistance) return up;
        return upLeft;
    }

    static crc32(bytes) {
        let crc = 0xffffffff;
        for (const byte of bytes) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }
}

class CanvasAnchorMask {
    static isAnchorEdge(image, x, y, options) {
        const pixel = CanvasAnchorMask.pixel(image, x, y);
        if (!CanvasAnchorMask.isDarkOrSaturated(pixel, options)) return false;
        const contrast = Math.max(
            CanvasAnchorMask.distance(pixel, CanvasAnchorMask.pixel(image, Math.max(0, x - 1), y)),
            CanvasAnchorMask.distance(pixel, CanvasAnchorMask.pixel(image, Math.min(image.width - 1, x + 1), y)),
            CanvasAnchorMask.distance(pixel, CanvasAnchorMask.pixel(image, x, Math.max(0, y - 1))),
            CanvasAnchorMask.distance(pixel, CanvasAnchorMask.pixel(image, x, Math.min(image.height - 1, y + 1))),
        );
        return contrast >= options.edgeContrastMin;
    }

    static pixel(image, x, y) {
        const offset = (y * image.width + x) * image.channels;
        return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
    }

    static isDarkOrSaturated([red, green, blue], options) {
        const maximum = Math.max(red, green, blue) / 255;
        const minimum = Math.min(red, green, blue) / 255;
        const luma = (54 * red + 183 * green + 19 * blue) / 256;
        const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
        return luma <= options.darkLumaMax
            || (saturation >= options.saturationMin && maximum >= options.saturationValueMin);
    }

    static distance(left, right) {
        return Math.max(Math.abs(left[0] - right[0]), Math.abs(left[1] - right[1]), Math.abs(left[2] - right[2]));
    }
}

class CanvasAnchorComparison {
    static bboxDelta(left, right) {
        if (left === null || right === null) return null;
        return {
            x: Math.abs(left.x - right.x),
            y: Math.abs(left.y - right.y),
            width: Math.abs(left.width - right.width),
            height: Math.abs(left.height - right.height),
        };
    }

    static centroidDelta(left, right) {
        if (left === null || right === null) return null;
        const x = Math.abs(left.x - right.x);
        const y = Math.abs(left.y - right.y);
        return { x, y, distance: Math.hypot(x, y) };
    }

    static exceeds(delta, tolerance) {
        return Object.values(delta).some((value) => value > tolerance);
    }
}

class CanvasAnchorSelfTestPng {
    static encode(width, height, pixels, channels = 4, filterTypes = [0]) {
        const colorType = channels === 3 ? PNG_COLOR_TYPE_RGB : PNG_COLOR_TYPE_RGBA;
        const rows = Buffer.alloc(height * (width * channels + 1));
        for (let y = 0; y < height; y += 1) {
            const rowStart = y * (width * channels + 1);
            const rawRow = Buffer.from(pixels).subarray(y * width * channels, (y + 1) * width * channels);
            const previousRow = y === 0 ? null : Buffer.from(pixels).subarray((y - 1) * width * channels, y * width * channels);
            const filter = filterTypes[y % filterTypes.length];
            rows[rowStart] = filter;
            CanvasAnchorSelfTestPng.filterRow(rawRow, previousRow, channels, filter).copy(rows, rowStart + 1);
        }
        const header = Buffer.alloc(13);
        header.writeUInt32BE(width, 0);
        header.writeUInt32BE(height, 4);
        header[8] = PNG_BIT_DEPTH;
        header[9] = colorType;
        return Buffer.concat([PNG_SIGNATURE, CanvasAnchorSelfTestPng.chunk("IHDR", header), CanvasAnchorSelfTestPng.chunk("IDAT", deflateSync(rows)), CanvasAnchorSelfTestPng.chunk("IEND", Buffer.alloc(0))]);
    }

    static filterRow(rawRow, previousRow, channels, filter) {
        if (!Number.isInteger(filter) || filter < 0 || filter > 4) throw new Error(`Invalid self-test filter ${filter}.`);
        const filtered = Buffer.alloc(rawRow.length);
        for (let index = 0; index < rawRow.length; index += 1) {
            const left = index >= channels ? rawRow[index - channels] : 0;
            const up = previousRow === null ? 0 : previousRow[index];
            const upLeft = previousRow === null || index < channels ? 0 : previousRow[index - channels];
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = up;
            else if (filter === 3) predictor = Math.floor((left + up) / 2);
            else if (filter === 4) predictor = CanvasAnchorPng.paeth(left, up, upLeft);
            filtered[index] = (rawRow[index] - predictor) & 255;
        }
        return filtered;
    }

    static chunk(type, payload) {
        const bytes = Buffer.alloc(12 + payload.length);
        bytes.writeUInt32BE(payload.length, 0);
        bytes.write(type, 4, 4, "ascii");
        payload.copy(bytes, 8);
        bytes.writeUInt32BE(CanvasAnchorPng.crc32(bytes.subarray(4, 8 + payload.length)), 8 + payload.length);
        return bytes;
    }
}

function selfTestImage(offsetX = 0, channels = 4, columns = 4, color = [10, 30, 220]) {
    const width = 12;
    const height = 10;
    const pixels = Buffer.alloc(width * height * channels, 235);
    for (let y = 3; y <= 6; y += 1) {
        for (let x = 4 + offsetX; x < 4 + offsetX + columns; x += 1) {
            const index = (y * width + x) * channels;
            pixels[index] = color[0];
            pixels[index + 1] = color[1];
            pixels[index + 2] = color[2];
            if (channels === 4) pixels[index + 3] = 255;
        }
    }
    return CanvasAnchorSelfTestPng.encode(width, height, pixels, channels);
}

function runSelfTest() {
    const rgba = selfTestImage(0, 4);
    const rgb = selfTestImage(0, 3);
    const filteredPng = CanvasAnchorSelfTestPng.encode(
        12,
        10,
        (() => {
            const pixels = Buffer.alloc(12 * 10 * 4, 235);
            for (let y = 3; y <= 6; y += 1) {
                for (let x = 4; x <= 7; x += 1) {
                    const index = (y * 12 + x) * 4;
                    pixels[index] = 10;
                    pixels[index + 1] = 30;
                    pixels[index + 2] = 220;
                    pixels[index + 3] = 255;
                }
            }
            return pixels;
        })(),
        4,
        [0, 1, 2, 3, 4],
    );
    const decodedRgba = decodePng(rgba);
    const decodedRgb = decodePng(rgb);
    assert.equal(decodedRgba.channels, 4);
    assert.equal(decodedRgb.channels, 3);
    assert.equal(decodedRgba.width, decodedRgb.width);
    assert.equal(decodedRgba.height, decodedRgb.height);
    assert.deepEqual(decodedRgba.data.subarray(0, 3), decodedRgb.data.subarray(0, 3));
    assert.deepEqual(decodedRgba.data, decodePng(filteredPng).data);
    const filtered = analyzeCanvasAnchor(rgba, { roi: { x: 2, y: 1, width: 8, height: 8 } });
    assert.equal(filtered.maskCount, 12);
    assert.deepEqual(filtered.bbox, { x: 2, y: 2, width: 4, height: 4 });
    assert.deepEqual(filtered.centroid, { x: 3.5, y: 3.5 });
    const similar = compareCanvasAnchors(rgba.toString("base64"), { data: rgb.toString("base64") });
    assert.equal(similar.valid, true);
    assert.equal(similar.maskSelection, undefined);
    const fallbackImage = selfTestImage(0, 4, 4, [90, 90, 90]);
    const fallbackSimilar = compareCanvasAnchors(fallbackImage, fallbackImage);
    assert.equal(fallbackSimilar.valid, true);
    assert.equal(fallbackSimilar.maskSelection?.selectedDarkLumaMax, FALLBACK_DARK_LUMA_MAX);
    assert.equal(compareCanvasAnchors(fallbackImage, selfTestImage(4, 4, 4, [90, 90, 90])).valid, false);
    const shifted = compareCanvasAnchors(rgba, selfTestImage(4, 4));
    assert.equal(shifted.valid, false);
    assert.match(shifted.reasons.join("\n"), /bbox delta exceeds/);
    assert.match(shifted.reasons.join("\n"), /centroid distance/);
    const differentMaskCount = compareCanvasAnchors(rgba, selfTestImage(0, 4, 2), {
        bboxTolerancePx: 100,
        centroidTolerancePx: 100,
    });
    assert.equal(differentMaskCount.valid, false);
    assert.match(differentMaskCount.reasons.join("\n"), /mask-count relative delta/);
    console.log("canvas-anchor self-test passed");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    if (process.argv.slice(2).length !== 1 || process.argv[2] !== "--self-test") {
        console.error("Usage: node scripts/canvas-anchor.mjs --self-test");
        process.exitCode = 1;
    } else {
        runSelfTest();
    }
}
