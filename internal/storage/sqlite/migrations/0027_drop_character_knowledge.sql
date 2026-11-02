-- Characters no longer have a knowledge level. Remove the stored value the way
-- an ordinary save changes a record, so an editor still holding the old record
-- gets a conflict instead of writing the field back. Location knowledge stays.
UPDATE campaign_collections SET revision = revision + 1
WHERE name = 'characters'
  AND EXISTS (SELECT 1 FROM campaign_records WHERE collection_name = 'characters' AND json_type(body_json, '$.knowledge') IS NOT NULL);
UPDATE campaign_record_versions SET revision = revision + 1
WHERE collection_name = 'characters' AND deleted = 0
  AND record_key IN (SELECT record_key FROM campaign_records WHERE collection_name = 'characters' AND json_type(body_json, '$.knowledge') IS NOT NULL);
UPDATE campaign_records SET revision = revision + 1, body_json = json_remove(body_json, '$.knowledge')
WHERE collection_name = 'characters' AND json_type(body_json, '$.knowledge') IS NOT NULL;

-- Remove it from stored recovery points too, so restoring one never brings the
-- field back.
UPDATE recovery_points SET image_json = json_set(image_json, '$.records', (
    SELECT json_group_array(json(CASE
        WHEN item.value ->> 'collection_name' = 'characters'
            AND json_type((item.value ->> 'body_json'), '$.knowledge') IS NOT NULL
            THEN json_set(item.value, '$.body_json', '' || json_remove((item.value ->> 'body_json'), '$.knowledge'))
        ELSE item.value END) ORDER BY item.key)
    FROM json_each(recovery_points.image_json, '$.records') AS item))
WHERE json_type(image_json, '$.records') = 'array'
  AND EXISTS (SELECT 1 FROM json_each(recovery_points.image_json, '$.records') AS item
      WHERE item.value ->> 'collection_name' = 'characters'
        AND json_type((item.value ->> 'body_json'), '$.knowledge') IS NOT NULL);
