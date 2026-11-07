-- No record has a knowledge level any more: characters lost theirs in 0027,
-- and locations (the only other records that stored one) lose it here. Remove
-- the stored value from every campaign record the way an ordinary save
-- changes a record, so an editor still holding the old record gets a conflict
-- instead of writing the field back.
UPDATE campaign_collections SET revision = revision + 1
WHERE name IN (SELECT collection_name FROM campaign_records WHERE json_type(body_json, '$.knowledge') IS NOT NULL);
UPDATE campaign_record_versions SET revision = revision + 1
WHERE deleted = 0
  AND (collection_name, record_key) IN (
    SELECT collection_name, record_key FROM campaign_records WHERE json_type(body_json, '$.knowledge') IS NOT NULL);
UPDATE campaign_records SET revision = revision + 1, body_json = json_remove(body_json, '$.knowledge')
WHERE json_type(body_json, '$.knowledge') IS NOT NULL;

-- Remove it from stored campaign recovery points too, so restoring one never
-- brings the field back.
UPDATE recovery_points SET image_json = json_set(image_json, '$.records', (
    SELECT json_group_array(json(CASE
        WHEN json_type((item.value ->> 'body_json'), '$.knowledge') IS NOT NULL
            THEN json_set(item.value, '$.body_json', '' || json_remove((item.value ->> 'body_json'), '$.knowledge'))
        ELSE item.value END) ORDER BY item.key)
    FROM json_each(recovery_points.image_json, '$.records') AS item))
WHERE json_type(image_json, '$.records') = 'array'
  AND EXISTS (SELECT 1 FROM json_each(recovery_points.image_json, '$.records') AS item
      WHERE json_type((item.value ->> 'body_json'), '$.knowledge') IS NOT NULL);
