-- A recovery point belongs to one part: the campaign or one add-on. A write
-- captures only the part it changes, and each part keeps its own history and
-- capture throttle. Part images are built by the recovery store, so the
-- combined view is retired.
DROP TRIGGER recovery_point_inserted;
DROP VIEW recovery_image;

CREATE TABLE recovery_points_next (
    point_id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL CHECK(scope IN ('campaign', 'addon')),
    addon_id TEXT NOT NULL CHECK(scope = 'campaign' AND addon_id = '' OR scope = 'addon' AND length(addon_id) BETWEEN 1 AND 200),
    created_at TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('manual', 'save', 'pre-restore', 'download', 'imported')),
    image_json TEXT NOT NULL CHECK(json_valid(image_json) AND length(CAST(image_json AS BLOB)) <= 67108864)
) STRICT;

-- Split every combined point, oldest first, into its campaign context (unless
-- it was deleted) and one point per add-on context. A blob's owner is not part
-- of an image; like every reader, the split looks it up in the live table.
-- Each image keeps all keys so readers can decode it without special cases.
INSERT INTO recovery_points_next(scope, addon_id, created_at, reason, image_json)
SELECT scope, addon_id, created_at, reason, image_json FROM (
    SELECT p.point_id, 0 AS part_order, 'campaign' AS scope, '' AS addon_id, p.created_at, p.reason, json_object(
        'version', 1,
        'collections', json(COALESCE(p.image_json -> '$.collections', '[]')),
        'records', json(COALESCE(p.image_json -> '$.records', '[]')),
        'sets', json('[]'),
        'documents', json('[]'),
        'blobs', (SELECT json_group_array(json(item.value)) FROM json_each(p.image_json, '$.blobs') AS item
            LEFT JOIN blobs AS b ON b.blob_id = item.value ->> 'blob_id' WHERE b.owner_kind IS NOT 'addon'),
        'assets', json(COALESCE(p.image_json -> '$.assets', '[]')),
        'packages', json('[]')) AS image_json
    FROM recovery_points AS p
    WHERE COALESCE(json_extract(p.image_json, '$.campaignAvailable'), 1)
    UNION ALL
    SELECT p.point_id, 1, 'addon', owners.addon_id, p.created_at, p.reason, json_object(
        'version', 1,
        'collections', json('[]'),
        'records', json('[]'),
        'sets', (SELECT json_group_array(json(item.value)) FROM json_each(p.image_json, '$.sets') AS item
            WHERE item.value ->> 'addon_id' = owners.addon_id),
        'documents', (SELECT json_group_array(json(item.value)) FROM json_each(p.image_json, '$.documents') AS item
            WHERE item.value ->> 'addon_id' = owners.addon_id),
        'blobs', (SELECT json_group_array(json(item.value)) FROM json_each(p.image_json, '$.blobs') AS item
            JOIN blobs AS b ON b.blob_id = item.value ->> 'blob_id' WHERE b.owner_kind = 'addon' AND b.owner_id = owners.addon_id),
        'assets', json('[]'),
        'packages', (SELECT json_group_array(json(item.value)) FROM json_each(p.image_json, '$.packages') AS item
            WHERE item.value ->> 'addon_id' = owners.addon_id))
    FROM recovery_points AS p JOIN (
        SELECT point.point_id, item.value ->> 'addon_id' AS addon_id
        FROM recovery_points AS point, json_each(point.image_json, '$.packages') AS item
        UNION
        SELECT point.point_id, item.value ->> 'addon_id'
        FROM recovery_points AS point, json_each(point.image_json, '$.sets') AS item
        UNION
        SELECT point.point_id, b.owner_id
        FROM recovery_points AS point, json_each(point.image_json, '$.blobs') AS item
        JOIN blobs AS b ON b.blob_id = item.value ->> 'blob_id' WHERE b.owner_kind = 'addon'
    ) AS owners ON owners.point_id = p.point_id
)
ORDER BY point_id, part_order, addon_id;

-- Combined capture saved a part again whenever another part changed. Of each
-- run of identical automatic points in one part, keep only the newest: it is
-- the state just before that part's next edit group.
DELETE FROM recovery_points_next WHERE point_id IN (
    SELECT point_id FROM (
        SELECT point_id, reason, image_json,
            lead(reason) OVER part AS next_reason,
            lead(image_json) OVER part AS next_image
        FROM recovery_points_next
        WINDOW part AS (PARTITION BY scope, addon_id ORDER BY point_id))
    WHERE reason = 'save' AND next_reason = 'save' AND image_json = next_image);

DROP TABLE recovery_points;
ALTER TABLE recovery_points_next RENAME TO recovery_points;
CREATE INDEX recovery_points_part ON recovery_points(scope, addon_id, point_id);

CREATE TABLE recovery_capture (
    scope TEXT NOT NULL CHECK(scope IN ('campaign', 'addon')),
    addon_id TEXT NOT NULL,
    last_capture REAL NOT NULL,
    PRIMARY KEY(scope, addon_id)
) STRICT;
ALTER TABLE recovery_control DROP COLUMN last_capture;

CREATE TRIGGER recovery_point_inserted AFTER INSERT ON recovery_points BEGIN
    UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
    DELETE FROM recovery_points WHERE scope = NEW.scope AND addon_id = NEW.addon_id AND point_id NOT IN (
        SELECT point_id FROM recovery_points WHERE scope = NEW.scope AND addon_id = NEW.addon_id
        ORDER BY point_id DESC LIMIT 50);
END;

-- Point IDs changed, so any open review must be read again.
UPDATE recovery_control SET revision = revision + 1 WHERE singleton = 1;
